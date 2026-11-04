import express from 'express';
import helmet from 'helmet';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z, ZodError } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transaction } from './db.js';
import { queueMail } from './mail.js';
import { createMaintenance } from './maintenance.js';
import { bootstrap } from './bootstrap.js';
import { registerContent } from './content.js';
import {
  email,
  password,
  name,
  role,
  uuid,
  tokenSchema,
  token,
  digest,
  hashPassword,
  verifyPassword,
  parse,
  fail,
  HttpError,
  limit,
  membership,
} from './security.js';

const genericReset = { message: 'Jika akun terdaftar, instruksi reset password akan dikirim.' };
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
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('Vary', 'Cookie');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!config.allowedOrigins.includes(req.get('origin'))) return next(new HttpError(403, 'Origin permintaan tidak diizinkan.'));
      if (!req.is('application/json')) return next(new HttpError(415, 'Gunakan application/json.'));
    }
    next();
  });
  app.use('/api/workspaces/:ws/content', express.json({ limit: '1mb' }));
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
      `SELECT s.*, u.email, u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.disabled_at IS NULL`,
      [digest(raw)],
    );
    return rows[0] || null;
  }
  async function authenticated(req, res, next) {
    req.session = await currentSession(req);
    if (!req.session) fail(401, 'Silakan login kembali.');
    if (!['GET', 'HEAD'].includes(req.method) && req.get('x-csrf-token') !== req.session.csrf_token)
      fail(403, 'Token keamanan tidak valid. Muat ulang halaman.');
    next();
  }
  async function issueSession(db, req, userId, remember = false) {
    const old = sessionToken(req);
    if (old) await db.query('DELETE FROM sessions WHERE token_hash=$1', [digest(old)]);
    const raw = token(),
      csrfToken = token();
    const duration = remember ? 30 * 86400 : 12 * 3600;
    await db.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES ($1,$2,$3,now()+$4*interval '1 second')", [
      digest(raw),
      userId,
      csrfToken,
      duration,
    ]);
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
    if (!rows.length) fail(400, 'Undangan tidak valid atau sudah kedaluwarsa.');
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
    if (!config.BOOTSTRAP_TOKEN) fail(404, 'Setup owner belum diaktifkan atau sudah ditutup.');
    await limit(pool, `owner-bootstrap:${req.ip}`, 5, 900);
    const input = parse(z.object({ setupToken: z.string().min(32).max(256), email, name, workspace: name, password }).strict(), req.body);
    if (!timingSafeEqual(Buffer.from(digest(input.setupToken)), Buffer.from(digest(config.BOOTSTRAP_TOKEN)))) fail(403, 'Kunci setup tidak sesuai.');
    await bootstrap(pool, { email: input.email, name: input.name, workspace: input.workspace, password: input.password });
    res.status(201).json({ message: 'Akun owner berhasil dibuat. Silakan login.' });
  });
  app.get('/api/internal/maintenance', async (req, res) => {
    if (!config.CRON_SECRET || !timingSafeEqual(Buffer.from(digest(req.get('authorization') || '')), Buffer.from(digest(`Bearer ${config.CRON_SECRET}`)))) {
      fail(401, 'Akses tidak diizinkan.');
    }
    res.json(await app.locals.maintain({ maxMessages: 1 }));
  });
  app.get('/api/auth/me', authenticated, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT w.id,w.name,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=$1 AND m.active ORDER BY w.created_at,w.id',
      [req.session.user_id],
    );
    res.json({
      user: { id: req.session.user_id, email: req.session.email, name: req.session.name },
      csrfToken: req.session.csrf_token,
      workspaces: rows,
      features: { email: emailEnabled },
    });
  });
  app.post('/api/auth/login', async (req, res) => {
    const input = parse(z.object({ email, password: z.string().min(1).max(128), remember: z.boolean().default(false) }).strict(), req.body);
    await authLimit(req, 'login', input.email);
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [input.email]);
    const user = rows[0];
    const valid = await verifyPassword(input.password, user?.password_hash || dummyPassword);
    if (!valid || !user || user.disabled_at) fail(401, 'Email atau password tidak sesuai.');
    const session = await transaction(pool, async db => {
      // Serialize with password reset so a stale password cannot create a session after reset.
      const { rows: latest } = await db.query('SELECT password_hash,disabled_at FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      if (latest[0].password_hash !== user.password_hash || latest[0].disabled_at) fail(401, 'Email atau password tidak sesuai.');
      return issueSession(db, req, user.id, input.remember);
    });
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
    if (existingSession && req.get('x-csrf-token') !== existingSession.csrf_token) fail(403, 'Muat ulang halaman sebelum menerima undangan.');
    // Work-factor outside the transaction; token is rechecked under a lock before use.
    const hash = input.password ? await hashPassword(input.password) : null;
    const result = await transaction(pool, async db => {
      const preview = await invitation(db, input.token);
      await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [preview.workspace_id]);
      const invite = await invitation(db, input.token, true);
      const { rows } = await db.query('SELECT * FROM users WHERE email=$1 FOR UPDATE', [invite.email]);
      let user = rows[0];
      if (user) {
        if (!existingSession || existingSession.user_id !== user.id || user.disabled_at) fail(401, 'Login dengan akun penerima undangan untuk melanjutkan.');
        const { rowCount } = await db.query('SELECT 1 FROM sessions WHERE token_hash=$1 AND expires_at>now()', [existingSession.token_hash]);
        if (!rowCount) fail(401, 'Silakan login kembali.');
      } else {
        if (existingSession) fail(409, 'Logout terlebih dahulu untuk membuat akun penerima undangan.');
        if (!input.name || !hash) fail(400, 'Nama dan password minimal 12 karakter diperlukan.');
        user = { id: randomUUID(), email: invite.email, name: input.name };
        await db.query('INSERT INTO users(id,email,name,password_hash,email_verified_at) VALUES ($1,$2,$3,$4,now())', [user.id, user.email, user.name, hash]);
      }
      // Existing active roles are retained; accepting an invite cannot demote an owner.
      await db.query(
        `INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO UPDATE SET active=true, role=CASE WHEN memberships.active THEN memberships.role ELSE EXCLUDED.role END`,
        [invite.workspace_id, user.id, invite.role],
      );
      await db.query('UPDATE invitations SET consumed_at=now() WHERE id=$1', [invite.id]);
      await audit(db, invite.workspace_id, user.id, 'invitation.accepted', invite.id);
      return { user, session: await issueSession(db, req, user.id) };
    });
    setSession(res, result.session);
    res.status(201).json({ user: publicUser(result.user) });
  });
  app.post('/api/auth/forgot-password', async (req, res) => {
    if (!emailEnabled) fail(503, 'Pengiriman email belum diaktifkan. Hubungi admin untuk pemulihan akun.');
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
        body: `Buka tautan ini untuk mengganti password. Berlaku 30 menit dan hanya satu kali.\n${config.APP_ORIGIN}/#reset=${raw}`,
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
      if (!rows.length) fail(400, 'Tautan reset tidak valid atau sudah kedaluwarsa.');
      // All reset/issue operations take the user lock first, avoiding lock-order inversions.
      const user = await db.query('SELECT id FROM users WHERE id=$1 AND disabled_at IS NULL FOR UPDATE', [rows[0].user_id]);
      if (!user.rowCount) fail(400, 'Tautan reset tidak valid atau sudah kedaluwarsa.');
      const reset = await db.query('SELECT 1 FROM password_resets WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE', [
        digest(input.token),
      ]);
      if (!reset.rowCount) fail(400, 'Tautan reset tidak valid atau sudah kedaluwarsa.');
      await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, rows[0].user_id]);
      await db.query('UPDATE password_resets SET consumed_at=now() WHERE user_id=$1 AND consumed_at IS NULL', [rows[0].user_id]);
      await db.query('DELETE FROM sessions WHERE user_id=$1', [rows[0].user_id]);
    });
    res.clearCookie(cookieName, cookieOptions).json({ message: 'Password diperbarui. Silakan login kembali.' });
  });

  registerContent(app, pool, authenticated);
  app.use('/api/workspaces', authenticated);
  app.post('/api/workspaces', async (req, res) => {
    await limit(pool, `workspace:${req.session.user_id}`, 10, 3600);
    const input = parse(z.object({ name }).strict(), req.body);
    const id = randomUUID();
    await transaction(pool, async db => {
      await db.query('INSERT INTO workspaces(id,name) VALUES ($1,$2)', [id, input.name]);
      await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,'owner')", [id, req.session.user_id]);
      await audit(db, id, req.session.user_id, 'workspace.created', id);
    });
    res.status(201).json({ id, name: input.name, role: 'owner' });
  });
  app.get('/api/workspaces/:ws', async (req, res) => {
    const ownRole = await membership(pool, req.params.ws, req.session.user_id);
    const [workspace, members, teams] = await Promise.all([
      pool.query('SELECT id,name FROM workspaces WHERE id=$1', [req.params.ws]),
      pool.query(
        'SELECT u.id,u.name,u.email,m.role,m.active FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 ORDER BY m.joined_at,u.id',
        [req.params.ws],
      ),
      pool.query(
        `SELECT t.id,t.name,coalesce(array_agg(tm.user_id) FILTER (WHERE tm.user_id IS NOT NULL),'{}') AS members FROM teams t LEFT JOIN team_members tm ON tm.team_id=t.id WHERE t.workspace_id=$1 GROUP BY t.id ORDER BY t.name`,
        [req.params.ws],
      ),
    ]);
    res.json({ ...workspace.rows[0], role: ownRole, members: members.rows, teams: teams.rows });
  });
  app.patch('/api/workspaces/:ws', async (req, res) => {
    const input = parse(z.object({ name }).strict(), req.body);
    await transaction(pool, async db => {
      await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin'], true);
      await db.query('UPDATE workspaces SET name=$1 WHERE id=$2', [input.name, req.params.ws]);
      await audit(db, req.params.ws, req.session.user_id, 'workspace.renamed', req.params.ws);
    });
    res.status(204).end();
  });
  app.get('/api/workspaces/:ws/invitations', async (req, res) => {
    await membership(pool, req.params.ws, req.session.user_id, ['owner', 'admin']);
    const { rows } = await pool.query(
      'SELECT id,email,role,expires_at,created_at FROM invitations WHERE workspace_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC',
      [req.params.ws],
    );
    res.json(rows);
  });
  app.post('/api/workspaces/:ws/invitations', async (req, res) => {
    if (!emailEnabled) fail(503, 'Pengiriman email belum diaktifkan. Admin perlu mengatur SMTP sebelum mengirim undangan.');
    const input = parse(z.object({ email, role: z.enum(['admin', 'member']).default('member') }).strict(), req.body);
    await limit(pool, `invite:${req.session.user_id}`, 30, 3600);
    const id = randomUUID();
    await transaction(pool, async db => {
      const ownRole = await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin'], true);
      if (ownRole !== 'owner' && input.role !== 'member') fail(403, 'Hanya owner yang dapat mengundang admin.');
      const active = await db.query('SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE workspace_id=$1 AND u.email=$2 AND m.active', [
        req.params.ws,
        input.email,
      ]);
      if (active.rowCount) fail(409, 'Pengguna sudah menjadi anggota aktif.');
      await db.query('UPDATE invitations SET revoked_at=now() WHERE workspace_id=$1 AND email=$2 AND consumed_at IS NULL AND revoked_at IS NULL', [
        req.params.ws,
        input.email,
      ]);
      const raw = token();
      await db.query(
        "INSERT INTO invitations(id,workspace_id,email,role,token_hash,invited_by,expires_at) VALUES ($1,$2,$3,$4,$5,$6,now()+interval '48 hours')",
        [id, req.params.ws, input.email, input.role, digest(raw), req.session.user_id],
      );
      await queueMail(db, {
        to: input.email,
        subject: 'Undangan bergabung ke workspace',
        body: `Anda diundang ke workspace. Buka tautan ini dalam 48 jam.\n${config.APP_ORIGIN}/#invite=${raw}`,
        invitationId: id,
      });
      await audit(db, req.params.ws, req.session.user_id, 'invitation.created', id);
    });
    res.status(201).json({ id, message: 'Undangan masuk antrean pengiriman email.' });
  });
  app.delete('/api/workspaces/:ws/invitations/:id', async (req, res) => {
    uuid.parse(req.params.id);
    await transaction(pool, async db => {
      const ownRole = await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin'], true);
      const invite = await db.query('SELECT role FROM invitations WHERE id=$1 AND workspace_id=$2', [req.params.id, req.params.ws]);
      if (!invite.rowCount) fail(404, 'Undangan tidak ditemukan.');
      if (ownRole !== 'owner' && invite.rows[0].role === 'admin') fail(403, 'Hanya owner yang dapat mengelola undangan admin.');
      await db.query('UPDATE invitations SET revoked_at=now() WHERE id=$1', [req.params.id]);
      await audit(db, req.params.ws, req.session.user_id, 'invitation.revoked', req.params.id);
    });
    res.status(204).end();
  });
  app.patch('/api/workspaces/:ws/members/:user', async (req, res) => {
    uuid.parse(req.params.user);
    const input = parse(
      z
        .object({ role: role.optional(), active: z.boolean().optional() })
        .strict()
        .refine(i => i.role !== undefined || i.active !== undefined),
      req.body,
    );
    await transaction(pool, async db => {
      const ownRole = await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin'], true);
      const { rows } = await db.query('SELECT role,active FROM memberships WHERE workspace_id=$1 AND user_id=$2', [req.params.ws, req.params.user]);
      const target = rows[0];
      if (!target) fail(404, 'Anggota tidak ditemukan.');
      if (ownRole !== 'owner' && (target.role !== 'member' || (input.role && input.role !== 'member'))) fail(403, 'Admin hanya dapat mengelola anggota biasa.');
      const nextRole = input.role ?? target.role,
        active = input.active ?? target.active;
      if (target.active && target.role === 'owner' && (!active || nextRole !== 'owner')) {
        const owners = await db.query("SELECT 1 FROM memberships WHERE workspace_id=$1 AND role='owner' AND active", [req.params.ws]);
        if (owners.rowCount <= 1) fail(409, 'Workspace harus memiliki minimal satu owner aktif.');
      }
      await db.query('UPDATE memberships SET role=$1,active=$2 WHERE workspace_id=$3 AND user_id=$4', [nextRole, active, req.params.ws, req.params.user]);
      if (!active) await db.query('DELETE FROM team_members WHERE workspace_id=$1 AND user_id=$2', [req.params.ws, req.params.user]);
      // Revocation cannot be bypassed by an older pending invitation.
      if (!active)
        await db.query(
          'UPDATE invitations SET revoked_at=now() WHERE workspace_id=$1 AND email=(SELECT email FROM users WHERE id=$2) AND consumed_at IS NULL',
          [req.params.ws, req.params.user],
        );
      await audit(db, req.params.ws, req.session.user_id, 'membership.updated', req.params.user);
    });
    res.status(204).end();
  });
  app.post('/api/workspaces/:ws/teams', async (req, res) => {
    const input = parse(z.object({ name }).strict(), req.body),
      id = randomUUID();
    await transaction(pool, async db => {
      await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin'], true);
      await db.query('INSERT INTO teams(id,workspace_id,name) VALUES ($1,$2,$3)', [id, req.params.ws, input.name]);
      await audit(db, req.params.ws, req.session.user_id, 'team.created', id);
    });
    res.status(201).json({ id, name: input.name });
  });
  app.put('/api/workspaces/:ws/teams/:id/members', async (req, res) => {
    uuid.parse(req.params.id);
    const input = parse(
      z
        .object({
          members: z
            .array(uuid)
            .max(200)
            .refine(a => new Set(a).size === a.length),
        })
        .strict(),
      req.body,
    );
    await transaction(pool, async db => {
      await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin'], true);
      const team = await db.query('SELECT 1 FROM teams WHERE id=$1 AND workspace_id=$2', [req.params.id, req.params.ws]);
      if (!team.rowCount) fail(404, 'Tim tidak ditemukan.');
      const members = await db.query('SELECT user_id FROM memberships WHERE workspace_id=$1 AND active AND user_id=ANY($2::uuid[])', [
        req.params.ws,
        input.members,
      ]);
      if (members.rowCount !== input.members.length) fail(400, 'Tim hanya boleh berisi anggota aktif workspace ini.');
      await db.query('DELETE FROM team_members WHERE team_id=$1', [req.params.id]);
      await db.query('INSERT INTO team_members(workspace_id,team_id,user_id) SELECT $1,$2,unnest($3::uuid[])', [req.params.ws, req.params.id, input.members]);
      await audit(db, req.params.ws, req.session.user_id, 'team.members.updated', req.params.id);
    });
    res.status(204).end();
  });
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
      `SELECT o.id,o.recipient,o.attempts,o.sent_at,o.created_at FROM mail_outbox o JOIN invitations i ON i.id=o.invitation_id WHERE i.workspace_id=$1 ORDER BY o.created_at DESC LIMIT 50`,
      [req.params.ws],
    );
    res.json(rows);
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));
  if (production && !config.serverless) {
    const dist = fileURLToPath(new URL('../dist/', import.meta.url));
    app.use(express.static(dist, { index: 'index.html' }));
    app.get('/{*path}', (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error instanceof ZodError) return res.status(400).json({ error: 'ID atau parameter tidak valid.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Permintaan terlalu besar.' });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON tidak valid.' });
    if (error.code === '23505') return res.status(409).json({ error: 'Data sudah ada atau sedang diproses. Muat ulang lalu coba lagi.' });
    if (['42P01', '3F000'].includes(error.code))
      return res.status(503).json({ error: 'Jalankan migrasi database terbaru untuk proyek dan task terlebih dahulu.' });
    // Never log request bodies, SQL parameters, connection strings, or raw tokens.
    console.error('API operation failed:', error.code || error.name);
    res.status(500).json({ error: 'Layanan belum dapat memproses permintaan. Coba lagi.' });
  });
  return app;
}
