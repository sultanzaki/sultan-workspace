import { queueSecurityMail } from './mail.js';
import { z } from 'zod';
import { transaction } from './db.js';
import { digest, fail, limit, name, password, token, tokenSchema, uuid, hashPassword, verifyPassword } from './security.js';
import { encryptSecret, decryptSecret, newSecret, verifyFactor, recoveryCodes } from './mfa.js';
import { canReadProject } from './content-access.js';

export function profile(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    title: user.title || '',
    color: user.avatar_color || '#4B5BD6',
    avatar: user.has_avatar || user.avatar ? `/api/account/users/${user.id}/avatar?v=${+new Date(user.avatar_updated_at)}` : null,
  };
}
export async function beginMfaLogin(db, user, remember) {
  const security = (await db.query('SELECT enabled FROM user_security WHERE user_id=$1', [user.id])).rows[0];
  if (!security?.enabled) return null;
  const challenge = token();
  await db.query("INSERT INTO login_challenges(token_hash,user_id,password_hash,remember,expires_at) VALUES ($1,$2,$3,$4,now()+interval '5 minutes')", [
    digest(challenge),
    user.id,
    user.password_hash,
    remember,
  ]);
  return challenge;
}
export function registerAccounts(app, pool, config, { authenticated, issueSession, setSession, clearSession }) {
  const sensitive = z.object({ currentPassword: z.string().min(1).max(128), code: z.string().max(64).optional() });
  const secureLimit = req => limit(pool, `account-sensitive:${req.session.user_id}`, 15, 900);
  async function lockedUser(db, user) {
    const row = (await db.query('SELECT * FROM users WHERE id=$1 AND disabled_at IS NULL FOR UPDATE', [user])).rows[0];
    if (!row) fail(401, 'Please sign in again.');
    return row;
  }
  async function reauthenticate(db, req, input, alwaysMfa = false) {
    const user = await lockedUser(db, req.session.user_id);
    if (!(await verifyPassword(input.currentPassword, user.password_hash))) fail(401, 'Incorrect current password.');
    const security = (await db.query('SELECT enabled FROM user_security WHERE user_id=$1', [user.id])).rows[0];
    const recent = req.session.mfa_verified_at && Date.now() - new Date(req.session.mfa_verified_at).getTime() < 300000;
    if (security?.enabled && (alwaysMfa || !recent) && !(await verifyFactor(db, user.id, input.code, config)))
      fail(401, 'The two-factor or recovery code is invalid or has already been used.');
    return user;
  }
  app.post('/api/auth/mfa/login', async (req, res) => {
    const input = z
      .object({ challenge: tokenSchema, code: z.string().min(1).max(64) })
      .strict()
      .parse(req.body);
    await limit(pool, `mfa-ip:${req.ip}`, 30, 300);
    await limit(pool, `mfa-challenge:${digest(input.challenge)}`, 5, 300);
    const result = await transaction(pool, async db => {
      const preview = (await db.query('SELECT user_id FROM login_challenges WHERE token_hash=$1 AND expires_at>now()', [digest(input.challenge)])).rows[0];
      if (!preview) fail(401, 'Verification has expired. Sign in again.');
      const user = await lockedUser(db, preview.user_id);
      const challenge = (await db.query('SELECT * FROM login_challenges WHERE token_hash=$1 AND expires_at>now() FOR UPDATE', [digest(input.challenge)]))
        .rows[0];
      const security = (await db.query('SELECT enabled FROM user_security WHERE user_id=$1', [user.id])).rows[0];
      if (!challenge || challenge.password_hash !== user.password_hash || !security?.enabled) fail(401, 'Verification has changed. Sign in again.');
      if (!(await verifyFactor(db, user.id, input.code, config))) fail(401, 'The two-factor or recovery code is invalid or has already been used.');
      await db.query('DELETE FROM login_challenges WHERE token_hash=$1', [digest(input.challenge)]);
      return { user, session: await issueSession(db, req, user.id, challenge.remember, new Date()) };
    });
    setSession(res, result.session);
    res.json({ user: profile(result.user) });
  });
  app.get('/api/account', authenticated, async (req, res) => {
    const user = (
      await pool.query('SELECT id,email,name,title,avatar_color,avatar_updated_at,avatar IS NOT NULL AS has_avatar FROM users WHERE id=$1', [
        req.session.user_id,
      ])
    ).rows[0];
    const security = (
      await pool.query('SELECT enabled,(SELECT count(*)::integer FROM recovery_codes WHERE user_id=$1) AS codes FROM user_security WHERE user_id=$1', [user.id])
    ).rows[0];
    res.json({ user: profile(user), mfa: { enabled: !!security?.enabled, recoveryCodes: security?.codes || 0, configured: !!config.AUTH_ENCRYPTION_KEY } });
  });
  app.patch('/api/account/profile', authenticated, async (req, res) => {
    const input = z
      .object({ name, title: z.string().trim().max(100).default(''), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) })
      .strict()
      .parse(req.body);
    await pool.query('UPDATE users SET name=$1,title=$2,avatar_color=$3 WHERE id=$4', [input.name, input.title, input.color, req.session.user_id]);
    const user = (
      await pool.query('SELECT id,email,name,title,avatar_color,avatar_updated_at,avatar IS NOT NULL AS has_avatar FROM users WHERE id=$1', [
        req.session.user_id,
      ])
    ).rows[0];
    res.json(profile(user));
  });
  app.put('/api/account/avatar', authenticated, async (req, res) => {
    const input = z
        .object({ content: z.string().max(349528) })
        .strict()
        .parse(req.body),
      bytes = Buffer.from(input.content, 'base64');
    if (!bytes.length || bytes.length > 262144 || bytes.toString('base64') !== input.content) fail(400, 'The photo must be an image no larger than 256 KB.');
    let mime;
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
    else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
    else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') mime = 'image/webp';
    if (!mime) fail(415, 'Use a PNG, JPEG, or WebP image.');
    await pool.query('UPDATE users SET avatar=$1,avatar_mime=$2,avatar_updated_at=now() WHERE id=$3', [bytes, mime, req.session.user_id]);
    res.json({ ok: true });
  });
  app.delete('/api/account/avatar', authenticated, async (req, res) => {
    await pool.query('UPDATE users SET avatar=NULL,avatar_mime=NULL,avatar_updated_at=now() WHERE id=$1', [req.session.user_id]);
    res.sendStatus(204);
  });
  app.get('/api/account/users/:user/avatar', authenticated, async (req, res) => {
    const target = uuid.parse(req.params.user),
      self = req.session.user_id;
    if (target !== self) {
      const shared = (
        await pool.query(
          `SELECT a.workspace_id,a.role,b.role AS target_role FROM memberships a JOIN memberships b ON b.workspace_id=a.workspace_id
        WHERE a.user_id=$1 AND b.user_id=$2 AND a.active AND b.active`,
          [self, target],
        )
      ).rows;
      let allowed = shared.some(row => row.role !== 'guest');
      if (!allowed)
        for (const ws of shared) {
          const projects = (await pool.query('SELECT data FROM projects WHERE workspace_id=$1', [ws.workspace_id])).rows;
          if (projects.some(p => canReadProject(p.data, self, ws.role) && canReadProject(p.data, target, ws.target_role))) {
            allowed = true;
            break;
          }
        }
      if (!allowed) fail(404, 'Photo not found.');
    }
    const user = (await pool.query('SELECT avatar,avatar_mime FROM users WHERE id=$1 AND disabled_at IS NULL', [target])).rows[0];
    if (!user?.avatar) fail(404, 'Photo not found.');
    res.type(user.avatar_mime).set('X-Content-Type-Options', 'nosniff').send(user.avatar);
  });
  app.post('/api/account/password', authenticated, async (req, res) => {
    const input = sensitive.extend({ newPassword: password }).strict().parse(req.body);
    await secureLimit(req);
    if (input.newPassword === input.currentPassword) fail(400, 'Choose a different new password.');
    const encoded = await hashPassword(input.newPassword);
    await transaction(pool, async db => {
      await reauthenticate(db, req, input);
      await db.query('UPDATE users SET password_hash=$1 WHERE id=$2', [encoded, req.session.user_id]);
      await db.query('DELETE FROM sessions WHERE user_id=$1', [req.session.user_id]);
      await db.query('DELETE FROM login_challenges WHERE user_id=$1', [req.session.user_id]);
      await db.query('DELETE FROM password_resets WHERE user_id=$1', [req.session.user_id]);
      await queueSecurityMail(db, config, req.session.user_id, 'Your password has changed. All previous sessions have been revoked.');
    });
    clearSession(res);
    res.json({ message: 'Password changed. Sign in with your new password.' });
  });
  app.get('/api/account/sessions', authenticated, async (req, res) => {
    const rows = (
      await pool.query(
        'SELECT id,user_agent,created_at,expires_at,token_hash=$2 AS current FROM sessions WHERE user_id=$1 AND expires_at>now() ORDER BY created_at DESC',
        [req.session.user_id, req.session.token_hash],
      )
    ).rows;
    res.json(rows.map(row => ({ id: row.id, agent: row.user_agent || 'Browser', createdAt: row.created_at, expiresAt: row.expires_at, current: row.current })));
  });
  app.delete('/api/account/sessions/:id', authenticated, async (req, res) => {
    const result = await pool.query('DELETE FROM sessions WHERE id=$1 AND user_id=$2 RETURNING token_hash', [uuid.parse(req.params.id), req.session.user_id]);
    if (!result.rowCount) fail(404, 'Session not found.');
    const current = result.rows[0].token_hash === req.session.token_hash;
    if (current) clearSession(res);
    res.json({ current });
  });
  app.delete('/api/account/sessions', authenticated, async (req, res) => {
    await pool.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [req.session.user_id, req.session.token_hash]);
    res.json({ ok: true });
  });
  app.post('/api/account/mfa/setup', authenticated, async (req, res) => {
    const input = sensitive.strict().parse(req.body);
    await secureLimit(req);
    const result = await transaction(pool, async db => {
      const user = await reauthenticate(db, req, input);
      if ((await db.query('SELECT enabled FROM user_security WHERE user_id=$1', [user.id])).rows[0]?.enabled)
        fail(409, 'Two-factor authentication is already enabled.');
      const secret = newSecret(),
        encrypted = encryptSecret(secret, config, user.id);
      await db.query(
        `INSERT INTO user_security(user_id,pending_secret,pending_until) VALUES ($1,$2,now()+interval '10 minutes')
        ON CONFLICT(user_id) DO UPDATE SET pending_secret=EXCLUDED.pending_secret,pending_until=EXCLUDED.pending_until`,
        [user.id, encrypted],
      );
      return {
        secret,
        otpauth: `otpauth://totp/${encodeURIComponent('Gr8r Studio:' + user.email)}?secret=${secret}&issuer=Gr8r%20Studio&algorithm=SHA1&digits=6&period=30`,
      };
    });
    res.json(result);
  });
  app.post('/api/account/mfa/confirm', authenticated, async (req, res) => {
    const { code } = z
      .object({ code: z.string().regex(/^\d{6}$/) })
      .strict()
      .parse(req.body);
    await secureLimit(req);
    const codes = await transaction(pool, async db => {
      await lockedUser(db, req.session.user_id);
      const security = (await db.query('SELECT * FROM user_security WHERE user_id=$1 AND pending_until>now() FOR UPDATE', [req.session.user_id])).rows[0];
      if (!security?.pending_secret || security.enabled) fail(400, 'Two-factor setup has expired. Start again.');
      const secret = decryptSecret(security.pending_secret, config, req.session.user_id);
      await db.query('UPDATE user_security SET enabled=true,secret=$1,last_counter=-1 WHERE user_id=$2', [
        encryptSecret(secret, config, req.session.user_id),
        req.session.user_id,
      ]);
      if (!(await verifyFactor(db, req.session.user_id, code, config))) fail(401, 'Invalid authenticator code.');
      await db.query('UPDATE user_security SET pending_secret=NULL,pending_until=NULL WHERE user_id=$1', [req.session.user_id]);
      const updated = await db.query('UPDATE sessions SET mfa_verified_at=now() WHERE token_hash=$1 RETURNING id', [req.session.token_hash]);
      if (!updated.rowCount) fail(401, 'Please sign in again.');
      await db.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [req.session.user_id, req.session.token_hash]);
      await db.query('DELETE FROM login_challenges WHERE user_id=$1', [req.session.user_id]);
      await queueSecurityMail(db, config, req.session.user_id, 'Two-factor authentication (2FA) has been enabled.');
      return recoveryCodes(db, req.session.user_id);
    });
    res.json({ recoveryCodes: codes });
  });
  for (const action of ['disable', 'recovery'])
    app.post(`/api/account/mfa/${action}`, authenticated, async (req, res) => {
      const input = sensitive.strict().parse(req.body);
      await secureLimit(req);
      const result = await transaction(pool, async db => {
        const user = await reauthenticate(db, req, input, true);
        if (!(await db.query('SELECT enabled FROM user_security WHERE user_id=$1', [user.id])).rows[0]?.enabled)
          fail(400, 'Two-factor authentication is not enabled.');
        if (action === 'recovery') {
          await queueSecurityMail(db, config, user.id, 'Two-factor recovery codes regenerated. Previous recovery codes are no longer valid.');
          return { recoveryCodes: await recoveryCodes(db, user.id) };
        }
        await db.query('DELETE FROM user_security WHERE user_id=$1', [user.id]);
        await db.query('DELETE FROM recovery_codes WHERE user_id=$1', [user.id]);
        await db.query('DELETE FROM login_challenges WHERE user_id=$1', [user.id]);
        await db.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [user.id, req.session.token_hash]);
        await db.query('UPDATE sessions SET mfa_verified_at=NULL WHERE token_hash=$1', [req.session.token_hash]);
        await queueSecurityMail(db, config, user.id, 'Two-factor authentication (2FA) has been disabled.');
        return { ok: true };
      });
      res.json(result);
    });
  return { reauthenticate };
}
