import { resendWebhook, registerEmailRoutes } from './email-routes.js';
import express from 'express';
import helmet from 'helmet';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transaction } from './db.js';
import { queueMail, queueSecurityMail } from './mail.js';
import { createMaintenance } from './maintenance.js';
import { bootstrap } from './bootstrap.js';
import { registerContent } from './content.js';
import { registerCollaboration } from './collaboration.js';
import { registerAccounts, beginMfaLogin, profile } from './accounts.js';
import { registerAdministration, acceptProjectInvitation } from './administration.js';
import { email, password, name, tokenSchema, token, digest, hashPassword, verifyPassword, parse, fail, HttpError, limit, membership } from './security.js';

const genericReset = { message: 'If the account exists, password reset instructions will be sent.' };
const publicUser = user => ({ id: user.id, email: user.email, name: user.name });
const audit = (db, ws, actor, action, subject = null) =>
  db.query('INSERT INTO audit_events(workspace_id,actor_id,action,subject_id) VALUES ($1,$2,$3,$4)', [ws, actor, action, subject]);

export async function createApp(pool, config) {
  const app = express();
  app.locals.maintain = createMaintenance(pool, config);
  const emailEnabled = config.MAIL_TRANSPORT !== 'disabled';
  const production = config.NODE_ENV === 'production';
  const cookieName = production ? '__Host-sultan_session' : 'sultan_session';
  const cookieOptions = { httpOnly: true, secure: production, sameSite: 'lax', path: '/' };
  // Same password cost for unknown addresses. Generated once, not per failed lookup.
  const dummyPassword = await hashPassword(token());
  app.disable('x-powered-by');
  if (config.TRUST_PROXY_HOPS) app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: production ? [] : null,
        },
      },
      strictTransportSecurity: production ? undefined : false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.post('/api/webhooks/resend', express.raw({ type: 'application/json', limit: '128kb' }), resendWebhook(pool, config));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Vary', 'Cookie');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!config.allowedOrigins.includes(req.get('origin'))) return next(new HttpError(403, 'Request origin is not allowed.'));
      if (!req.is('application/json')) return next(new HttpError(415, 'Gunakan application/json.'));
    }
    next();
  });
  app.use('/api/workspaces/:ws/content', express.json({ limit: '1mb' }));
  app.use('/api/workspaces/:ws/files', express.json({ limit: '4300kb' }));
  app.use('/api/account/avatar', express.json({ limit: '400kb' }));
  app.use(express.json({ limit: '32kb' }));

  function sessionToken(req) {
    const cookie = req.headers.cookie
      ?.split(';')
      .map(c => c.trim())
      .find(c => c.startsWith(`${cookieName}=`));
    const value = cookie?.slice(cookieName.length + 1);
    return value && tokenSchema.safeParse(value).success ? value : null;
  }
  async function currentSession(req) {
    const raw = sessionToken(req);
    if (!raw) return null;
    const { rows } = await pool.query(
      `SELECT s.*,u.email,u.name,u.title,u.avatar_color,u.avatar_updated_at,u.avatar IS NOT NULL AS has_avatar FROM sessions s JOIN users u ON u.id=s.user_id
       LEFT JOIN user_security sec ON sec.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.disabled_at IS NULL AND (coalesce(sec.enabled,false)=false OR s.mfa_verified_at IS NOT NULL)`,
      [digest(raw)],
    );
    return rows[0] || null;
  }
  async function authenticated(req, res, next) {
    req.session = await currentSession(req);
    if (!req.session) fail(401, 'Please sign in again.');
    if (!['GET', 'HEAD'].includes(req.method) && req.get('x-csrf-token') !== req.session.csrf_token) fail(403, 'Invalid security token. Refresh the page.');
    next();
  }
  async function issueSession(db, req, userId, remember = false, mfaVerifiedAt = null) {
    const old = sessionToken(req);
    if (old) await db.query('DELETE FROM sessions WHERE token_hash=$1', [digest(old)]);
    const raw = token(),
      csrfToken = token();
    const duration = remember ? 30 * 86400 : 12 * 3600;
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at,user_agent,mfa_verified_at) VALUES ($1,$2,$3,now()+$4*interval '1 second',$5,$6)",
      [digest(raw), userId, csrfToken, duration, (req.get('user-agent') || '').slice(0, 300), mfaVerifiedAt],
    );
    return { raw, csrfToken, duration };
  }
  function setSession(res, session) {
    res.cookie(cookieName, session.raw, { ...cookieOptions, maxAge: session.duration * 1000 });
  }
  async function authLimit(req, scope, address = '') {
    await limit(pool, `${scope}:ip:${req.ip}`, 30, 900);
    if (address) await limit(pool, `${scope}:email:${address}`, 10, 900);
  }
  async function invitation(db, raw, lock = false) {
    const { rows } = await db.query(
      `SELECT i.*, w.name AS workspace_name FROM invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE token_hash=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() ${lock ? 'FOR UPDATE OF i' : ''}`,
      [digest(raw)],
    );
    if (!rows.length) fail(400, 'This invitation is invalid or has expired.');
    return rows[0];
  }

  app.get('/api/health', async (req, res) => {
    await pool.query('SELECT 1 FROM schema_migrations LIMIT 1');
    res.json({ status: 'ok' });
  });
  app.get('/api/auth/setup', async (req, res) => {
    if (!config.BOOTSTRAP_TOKEN) return res.json({ available: false });
    const users = await pool.query('SELECT 1 FROM users LIMIT 1');
    res.json({ available: users.rowCount === 0 });
  });
  app.post('/api/auth/setup', async (req, res) => {
    if (!config.BOOTSTRAP_TOKEN) fail(404, 'Owner setup is disabled or has already been completed.');
    await limit(pool, `owner-bootstrap:${req.ip}`, 5, 900);
    const input = parse(z.object({ setupToken: z.string().min(32).max(256), email, name, workspace: name, password }).strict(), req.body);
    if (!timingSafeEqual(Buffer.from(digest(input.setupToken)), Buffer.from(digest(config.BOOTSTRAP_TOKEN)))) fail(403, 'Incorrect setup key.');
    await bootstrap(pool, { email: input.email, name: input.name, workspace: input.workspace, password: input.password });
    res.status(201).json({ message: 'Owner account created. Please sign in.' });
  });
  app.get('/api/internal/maintenance', async (req, res) => {
    if (!config.CRON_SECRET || !timingSafeEqual(Buffer.from(digest(req.get('authorization') || '')), Buffer.from(digest(`Bearer ${config.CRON_SECRET}`)))) {
      fail(401, 'Access denied.');
    }
    res.json(await app.locals.maintain({ maxMessages: 100 }));
  });
  app.get('/api/auth/me', authenticated, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT w.id,w.name,w.slug,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 AND m.active ORDER BY w.created_at,w.id',
      [req.session.user_id],
    );
    res.json({
      user: profile({ ...req.session, id: req.session.user_id }),
      csrfToken: req.session.csrf_token,
      workspaces: rows,
      features: { email: emailEnabled, mfa: !!config.AUTH_ENCRYPTION_KEY, manualInvitations: true },
    });
  });
  app.post('/api/auth/login', async (req, res) => {
    const input = parse(z.object({ email, password: z.string().min(1).max(128), remember: z.boolean().default(false) }).strict(), req.body);
    await authLimit(req, 'login', input.email);
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [input.email]);
    const user = rows[0];
    const valid = await verifyPassword(input.password, user?.password_hash || dummyPassword);
    if (!valid || !user || user.disabled_at) fail(401, 'Incorrect email or password.');
    const session = await transaction(pool, async db => {
      // Serialize with password reset so a stale password cannot create a session after reset.
      const { rows: latest } = await db.query('SELECT password_hash,disabled_at FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      if (latest[0].password_hash !== user.password_hash || latest[0].disabled_at) fail(401, 'Incorrect email or password.');
      const challenge = await beginMfaLogin(db, user, input.remember);
      if (challenge) return { challenge };
      return issueSession(db, req, user.id, input.remember);
    });
    if (session.challenge) {
      res.status(202).json({ requiresMfa: true, challenge: session.challenge });
      return;
    }
    setSession(res, session);
    res.json({ user: publicUser(user) });
  });
  app.post('/api/auth/logout', authenticated, async (req, res) => {
    await pool.query('DELETE FROM sessions WHERE token_hash=$1', [req.session.token_hash]);
    res.clearCookie(cookieName, cookieOptions).status(204).end();
  });
  app.post('/api/auth/invitations/inspect', async (req, res) => {
    await authLimit(req, 'inspect');
    const input = parse(z.object({ token: tokenSchema }).strict(), req.body);
    const invite = await invitation(pool, input.token);
    const { rowCount } = await pool.query('SELECT 1 FROM users WHERE email=$1', [invite.email]);
    res.json({ email: invite.email, workspace: invite.workspace_name, existingAccount: rowCount > 0 });
  });
  app.post('/api/auth/invitations/accept', async (req, res) => {
    await authLimit(req, 'accept');
    const input = parse(z.object({ token: tokenSchema, name: name.optional(), password: password.optional() }).strict(), req.body);
    const existingSession = await currentSession(req);
    if (existingSession && req.get('x-csrf-token') !== existingSession.csrf_token) fail(403, 'Refresh the page before accepting the invitation.');
    // Work-factor outside the transaction; token is rechecked under a lock before use.
    const hash = input.password ? await hashPassword(input.password) : null;
    const result = await transaction(pool, async db => {
      const preview = await invitation(db, input.token);
      await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [preview.workspace_id]);
      const invite = await invitation(db, input.token, true);
      const { rows } = await db.query('SELECT * FROM users WHERE email=$1 FOR UPDATE', [invite.email]);
      let user = rows[0];
      if (user) {
        if (!existingSession || existingSession.user_id !== user.id || user.disabled_at) fail(401, 'Sign in with the invited account to continue.');
        const { rowCount } = await db.query('SELECT 1 FROM sessions WHERE token_hash=$1 AND expires_at>now()', [existingSession.token_hash]);
        if (!rowCount) fail(401, 'Please sign in again.');
      } else {
        if (existingSession) fail(409, 'Sign out before creating the invited account.');
        if (!input.name || !hash) fail(400, 'A name and a password of at least 12 characters are required.');
        user = { id: randomUUID(), email: invite.email, name: input.name };
        await db.query('INSERT INTO users(id,email,name,password_hash,email_verified_at) VALUES ($1,$2,$3,$4,now())', [user.id, user.email, user.name, hash]);
      }
      const previous = (await db.query('SELECT role,active FROM memberships WHERE workspace_id=$1 AND user_id=$2', [invite.workspace_id, user.id])).rows[0];
      // Existing active roles are retained; accepting an invite cannot demote an owner.
      await db.query(
        `INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO UPDATE SET active=true, role=CASE WHEN memberships.active THEN memberships.role ELSE EXCLUDED.role END`,
        [invite.workspace_id, user.id, invite.role],
      );
      await acceptProjectInvitation(db, invite, user, previous);
      await db.query('UPDATE invitations SET consumed_at=now() WHERE id=$1', [invite.id]);
      await audit(db, invite.workspace_id, user.id, 'invitation.accepted', invite.id);
      return { user, session: await issueSession(db, req, user.id, false, existingSession?.mfa_verified_at || null) };
    });
    setSession(res, result.session);
    res.status(201).json({ user: publicUser(result.user) });
  });
  app.post('/api/auth/forgot-password', async (req, res) => {
    if (!emailEnabled) fail(503, 'Email delivery is disabled. Contact an administrator to recover your account.');
    const input = parse(z.object({ email }).strict(), req.body);
    await authLimit(req, 'reset', input.email);
    await transaction(pool, async db => {
      const { rows } = await db.query('SELECT id FROM users WHERE email=$1 AND disabled_at IS NULL FOR UPDATE', [input.email]);
      if (!rows.length) return;
      await db.query('UPDATE password_resets SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL', [rows[0].id]);
      const raw = token(),
        hash = digest(raw);
      await db.query("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '30 minutes')", [hash, rows[0].id]);
      await queueMail(db, {
        to: input.email,
        subject: 'Reset password workspace',
        body: `Open this link to reset your password. It expires in 30 minutes and can only be used once.\n${config.APP_ORIGIN}/#reset=${raw}`,
        resetHash: hash,
      });
    });
    res.status(202).json(genericReset);
  });
  app.post('/api/auth/reset-password', async (req, res) => {
    await authLimit(req, 'reset-consume');
    const input = parse(z.object({ token: tokenSchema, password }).strict(), req.body);
    const hash = await hashPassword(input.password);
    await transaction(pool, async db => {
      const { rows } = await db.query('SELECT user_id FROM password_resets WHERE token_hash=$1', [digest(input.token)]);
      if (!rows.length) fail(400, 'This reset link is invalid or has expired.');
      // All reset/issue operations take the user lock first, avoiding lock-order inversions.
      const user = await db.query('SELECT id FROM users WHERE id=$1 AND disabled_at IS NULL FOR UPDATE', [rows[0].user_id]);
      if (!user.rowCount) fail(400, 'This reset link is invalid or has expired.');
      const reset = await db.query('SELECT 1 FROM password_resets WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE', [
        digest(input.token),
      ]);
      if (!reset.rowCount) fail(400, 'This reset link is invalid or has expired.');
      await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, rows[0].user_id]);
      await db.query('UPDATE password_resets SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL', [rows[0].user_id]);
      await db.query('DELETE FROM sessions WHERE user_id=$1', [rows[0].user_id]);
      await queueSecurityMail(db, config, rows[0].user_id, 'Your password has been reset. All previous sessions have been revoked.');
    });
    res.clearCookie(cookieName, cookieOptions).json({ message: 'Password updated. Please sign in again.' });
  });

  const accountSecurity = registerAccounts(app, pool, config, {
    authenticated,
    issueSession,
    setSession,
    clearSession: res => res.clearCookie(cookieName, cookieOptions),
  });
  app.locals.accountSecurity = accountSecurity;
  registerEmailRoutes(app, pool, { authenticated });
  registerContent(app, pool, authenticated);
  registerCollaboration(app, pool, authenticated);
  app.use('/api/workspaces', authenticated);
  registerAdministration(app, pool, config, accountSecurity);
  app.get('/api/workspaces/:ws/audit', async (req, res) => {
    await membership(pool, req.params.ws, req.session.user_id, ['owner', 'admin']);
    const { rows } = await pool.query(
      'SELECT a.id,a.action,a.subject_id,a.created_at,u.name AS actor FROM audit_events a JOIN users u ON u.id=a.actor_id WHERE workspace_id=$1 ORDER BY a.id DESC LIMIT 100',
      [req.params.ws],
    );
    res.json(rows);
  });
  app.get('/api/workspaces/:ws/mail-status', async (req, res) => {
    await membership(pool, req.params.ws, req.session.user_id, ['owner', 'admin']);
    const { rows } = await pool.query(
      `SELECT o.id,o.recipient,o.kind,o.attempts,o.sent_at,o.created_at,o.delivery_status,o.error_code FROM mail_outbox o LEFT JOIN invitations i ON i.id=o.invitation_id WHERE coalesce(o.workspace_id,i.workspace_id)=$1 ORDER BY o.created_at DESC LIMIT 50`,
      [req.params.ws],
    );
    res.json(rows);
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  if (production && !config.serverless) {
    const dist = fileURLToPath(new URL('../dist/', import.meta.url));
    app.use(express.static(dist, { index: 'index.html' }));
    app.get('/{*path}', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error instanceof ZodError) return res.status(400).json({ error: 'Invalid ID or parameter.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    if (error.code === '23505') return res.status(409).json({ error: 'This data already exists or is being processed. Refresh and try again.' });
    if (['42P01', '3F000', '42703'].includes(error.code))
      return res.status(503).json({ error: 'Run the latest database migrations to enable workspace features.' });
    // Never log request bodies, SQL parameters, connection strings, or raw tokens.
    console.error('API operation failed:', error.code || error.name);
    res.status(500).json({ error: 'The service cannot process this request yet. Try again.' });
  });
  return app;
}
