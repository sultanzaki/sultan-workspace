import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../server/config.js';
import { createPool, migrate } from '../server/db.js';
import { bootstrap } from '../server/bootstrap.js';
import { createApp } from '../server/app.js';
import { deliverOne } from '../server/mail.js';
import { digest } from '../server/security.js';

const origin = 'http://localhost:5173';
const ownerPassword = 'owner-test-password-123';
const memberPassword = 'member-test-password-123';
const secondPassword = 'second-test-password-123';

test('native authentication and workspace authorization against PostgreSQL', async t => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required. Run npm run db:local. Tests never use DATABASE_URL.');
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_test'),
    'Tests require an explicitly named, disposable local *_test database',
  );
  const config = readConfig({ NODE_ENV: 'test', DATABASE_URL: url.toString(), APP_ORIGIN: origin });
  const pool = createPool(config);
  t.after(() => pool.end());
  await pool.query('DROP SCHEMA IF EXISTS app_private CASCADE');
  await migrate(pool);
  const first = await bootstrap(pool, { email: 'OWNER@example.test', name: 'Owner', password: ownerPassword, workspace: 'Tim utama' });
  const app = await createApp(pool, config);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(route, { method = 'GET', body, actor, headers = {} } = {}) {
    const response = await fetch(base + '/api' + route, {
      method,
      headers: {
        ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}),
        ...(actor ? { cookie: actor.cookie, 'x-csrf-token': actor.csrf } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, headers: response.headers, data: response.status === 204 ? null : await response.json() };
  }
  async function login(email, password) {
    const result = await request('/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const actor = { cookie: result.headers.get('set-cookie').split(';')[0] };
    const me = await request('/auth/me', { actor });
    assert.equal(me.status, 200);
    return { ...actor, csrf: me.data.csrfToken, user: me.data.user };
  }
  const messages = [];
  async function drain() {
    for (let i = 0; i < 30; i++) if (!(await deliverOne(pool, async mail => messages.push(mail)))) break;
  }
  async function invite(actor, ws, email, role = 'member') {
    const response = await request(`/workspaces/${ws}/invitations`, { method: 'POST', actor, body: { email, role } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    assert.equal(response.data.token, undefined);
    await drain();
    const mail = messages.findLast(m => m.recipient === email);
    return { id: response.data.id, raw: mail.body.match(/#invite=([a-f0-9]{64})/)[1] };
  }
  let owner, member, admin, ws2, memberId, pending;

  await t.test('migrations are repeatable and private schema has no PUBLIC access', async () => {
    await migrate(pool);
    const result = await pool.query("SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname='app_private'");
    assert.ok(!result.rows[0].acl.includes('=U/'));
    await assert.rejects(bootstrap(pool, { email: 'other@example.test', name: 'Other', password: ownerPassword, workspace: 'Other' }), /Bootstrap sudah/);
  });
  await t.test('requires login and rejects public registration and bad credentials', async () => {
    assert.equal((await request('/auth/me')).status, 401);
    assert.equal((await request(`/workspaces/${first.workspaceId}`)).status, 401);
    assert.equal((await request('/auth/register', { method: 'POST', body: {} })).status, 404);
    for (const email of ['missing@example.test', 'owner@example.test']) {
      const result = await request('/auth/login', { method: 'POST', body: { email, password: 'incorrect-password' } });
      assert.equal(result.status, 401);
      assert.equal(result.data.error, 'Email atau password tidak sesuai.');
    }
    owner = await login('owner@example.test', ownerPassword);
    const raw = owner.cookie.split('=')[1];
    const result = await pool.query('SELECT token_hash FROM sessions WHERE user_id=$1', [first.userId]);
    assert.equal(result.rows[0].token_hash, digest(raw));
    assert.notEqual(result.rows[0].token_hash, raw);
  });
  await t.test('rejects hostile Origin, missing CSRF, non-JSON, and privilege mass assignment', async () => {
    const path = `/workspaces/${first.workspaceId}`;
    assert.equal((await request(path, { method: 'PATCH', actor: owner, body: { name: 'Bad' }, headers: { origin: 'https://evil.test' } })).status, 403);
    assert.equal((await request(path, { method: 'PATCH', actor: owner, body: { name: 'Bad' }, headers: { 'x-csrf-token': '' } })).status, 403);
    assert.equal((await request(path, { method: 'PATCH', actor: owner, body: { name: 'Bad' }, headers: { 'content-type': 'text/plain' } })).status, 415);
    assert.equal((await request('/workspaces', { method: 'POST', actor: owner, body: { name: 'Bad', ownerId: randomUUID() } })).status, 400);
  });
  await t.test('creates and renames persistent workspaces and creates teams', async () => {
    const created = await request('/workspaces', { method: 'POST', actor: owner, body: { name: 'Workspace kedua' } });
    assert.equal(created.status, 201);
    ws2 = created.data.id;
    assert.equal((await request(`/workspaces/${first.workspaceId}`, { method: 'PATCH', actor: owner, body: { name: 'Nama tim baru' } })).status, 204);
    assert.equal((await request(`/workspaces/${first.workspaceId}`, { actor: owner })).data.name, 'Nama tim baru');
    assert.equal((await request(`/workspaces/${first.workspaceId}/teams`, { method: 'POST', actor: owner, body: { name: 'Engineering' } })).status, 201);
  });
  await t.test('invitation establishes a verified account, membership and HttpOnly session once', async () => {
    const invitation = await invite(owner, first.workspaceId, 'member@example.test');
    const preview = await request('/auth/invitations/inspect', { method: 'POST', body: { token: invitation.raw } });
    assert.equal(preview.data.existingAccount, false);
    assert.equal(preview.data.email, 'member@example.test');
    const result = await request('/auth/invitations/accept', {
      method: 'POST',
      body: { token: invitation.raw, name: '<img src=x onerror=alert(1)>', password: memberPassword },
    });
    assert.equal(result.status, 201);
    memberId = result.data.user.id;
    assert.match(result.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(result.headers.get('set-cookie'), /SameSite=Lax/i);
    assert.equal(
      (await request('/auth/invitations/accept', { method: 'POST', body: { token: invitation.raw, name: 'Again', password: memberPassword } })).status,
      400,
    );
    member = await login('member@example.test', memberPassword);
    const { rows } = await pool.query('SELECT password_hash,email_verified_at FROM users WHERE id=$1', [memberId]);
    assert.notEqual(rows[0].password_hash, memberPassword);
    assert.match(rows[0].password_hash, /^scrypt\$65536\$/);
    assert.ok(rows[0].email_verified_at);
  });
  await t.test('member cannot administer, escalate or read another workspace', async () => {
    assert.equal((await request(`/workspaces/${first.workspaceId}`, { actor: member })).status, 200);
    for (const route of ['', '/invitations', '/audit', '/mail-status'])
      assert.equal((await request(`/workspaces/${ws2}${route}`, { actor: member })).status, 404);
    assert.equal(
      (await request(`/workspaces/${first.workspaceId}/invitations`, { method: 'POST', actor: member, body: { email: 'no@example.test' } })).status,
      403,
    );
    assert.equal(
      (await request(`/workspaces/${first.workspaceId}/members/${memberId}`, { method: 'PATCH', actor: member, body: { role: 'owner' } })).status,
      403,
    );
    assert.equal((await request(`/workspaces/${first.workspaceId}/teams`, { method: 'POST', actor: member, body: { name: 'Unauthorized' } })).status, 403);
  });
  await t.test('existing accounts must authenticate as invited user; invitation never resets a password', async () => {
    const invitation = await invite(owner, ws2, 'member@example.test');
    assert.equal(
      (await request('/auth/invitations/accept', { method: 'POST', body: { token: invitation.raw, name: 'Attacker', password: 'new-attacker-password' } }))
        .status,
      401,
    );
    assert.equal((await request('/auth/invitations/accept', { method: 'POST', actor: owner, body: { token: invitation.raw } })).status, 401);
    assert.equal((await request('/auth/invitations/accept', { method: 'POST', actor: member, body: { token: invitation.raw } })).status, 201);
    member = await login('member@example.test', memberPassword);
    assert.equal((await request(`/workspaces/${ws2}`, { actor: member })).status, 200);
  });
  await t.test('admin cannot promote, demote, deactivate or invite privileged users', async () => {
    const invitation = await invite(owner, first.workspaceId, 'admin@example.test', 'admin');
    assert.equal(
      (await request('/auth/invitations/accept', { method: 'POST', body: { token: invitation.raw, name: 'Admin', password: secondPassword } })).status,
      201,
    );
    admin = await login('admin@example.test', secondPassword);
    assert.equal(
      (await request(`/workspaces/${first.workspaceId}/members/${first.userId}`, { method: 'PATCH', actor: admin, body: { active: false } })).status,
      403,
    );
    assert.equal(
      (await request(`/workspaces/${first.workspaceId}/members/${memberId}`, { method: 'PATCH', actor: admin, body: { role: 'owner' } })).status,
      403,
    );
    assert.equal(
      (await request(`/workspaces/${first.workspaceId}/invitations`, { method: 'POST', actor: admin, body: { email: 'new@example.test', role: 'admin' } }))
        .status,
      403,
    );
    assert.equal(
      (await request(`/workspaces/${first.workspaceId}/invitations`, { method: 'POST', actor: owner, body: { email: 'new@example.test', role: 'owner' } }))
        .status,
      400,
    );
  });
  await t.test('last owner is protected even when simultaneous requests demote both owners', async () => {
    assert.equal(
      (await request(`/workspaces/${first.workspaceId}/members/${first.userId}`, { method: 'PATCH', actor: owner, body: { active: false } })).status,
      409,
    );
    await request(`/workspaces/${first.workspaceId}/members/${admin.user.id}`, { method: 'PATCH', actor: owner, body: { role: 'owner' } });
    const result = await Promise.all(
      [owner, admin].map(actor => request(`/workspaces/${first.workspaceId}/members/${actor.user.id}`, { method: 'PATCH', actor, body: { role: 'member' } })),
    );
    assert.deepEqual(result.map(r => r.status).sort(), [204, 409]);
    const { rows } = await pool.query("SELECT user_id FROM memberships WHERE workspace_id=$1 AND active AND role='owner'", [first.workspaceId]);
    assert.equal(rows.length, 1);
    // Restore fixture roles using whichever actor remains owner.
    const survivor = rows[0].user_id === owner.user.id ? owner : admin;
    await request(`/workspaces/${first.workspaceId}/members/${first.userId}`, { method: 'PATCH', actor: survivor, body: { role: 'owner' } });
    await request(`/workspaces/${first.workspaceId}/members/${admin.user.id}`, { method: 'PATCH', actor: owner, body: { role: 'admin' } });
  });
  await t.test('teams reject cross-workspace users and cross-workspace team IDs', async () => {
    const ws = (await request(`/workspaces/${first.workspaceId}`, { actor: owner })).data;
    const team = ws.teams[0];
    assert.equal(
      (await request(`/workspaces/${first.workspaceId}/teams/${team.id}/members`, { method: 'PUT', actor: owner, body: { members: [memberId] } })).status,
      204,
    );
    assert.equal((await request(`/workspaces/${ws2}/teams/${team.id}/members`, { method: 'PUT', actor: owner, body: { members: [memberId] } })).status, 404);
    assert.equal(
      (await request(`/workspaces/${first.workspaceId}/teams/${team.id}/members`, { method: 'PUT', actor: owner, body: { members: [randomUUID()] } })).status,
      400,
    );
    assert.equal(
      (await request(`/workspaces/${first.workspaceId}/teams/${team.id}/members`, { method: 'PUT', actor: owner, body: { members: [memberId, memberId] } }))
        .status,
      400,
    );
    assert.deepEqual((await request(`/workspaces/${first.workspaceId}`, { actor: owner })).data.teams[0].members, [memberId]);
  });
  await t.test('deactivation revokes workspace access immediately and removes team membership', async () => {
    assert.equal(
      (await request(`/workspaces/${first.workspaceId}/members/${memberId}`, { method: 'PATCH', actor: admin, body: { active: false } })).status,
      204,
    );
    assert.equal((await request(`/workspaces/${first.workspaceId}`, { actor: member })).status, 401);
    assert.equal((await request(`/workspaces/${ws2}`, { actor: member })).status, 401);
    member = await login('member@example.test', memberPassword);
    assert.equal((await request(`/workspaces/${first.workspaceId}`, { actor: member })).status, 404);
    assert.equal((await request(`/workspaces/${ws2}`, { actor: member })).status, 200);
    assert.deepEqual((await request(`/workspaces/${first.workspaceId}`, { actor: owner })).data.teams[0].members, []);
    await request(`/workspaces/${first.workspaceId}/members/${memberId}`, { method: 'PATCH', actor: owner, body: { active: true } });
  });
  await t.test('resending, expiry, revocation and simultaneous acceptance enforce one-time invitations', async () => {
    const initial = await invite(owner, first.workspaceId, 'pending@example.test');
    pending = await invite(owner, first.workspaceId, 'pending@example.test');
    assert.equal((await request('/auth/invitations/inspect', { method: 'POST', body: { token: initial.raw } })).status, 400);
    await pool.query("UPDATE invitations SET expires_at=now()-interval '1 second' WHERE id=$1", [pending.id]);
    assert.equal((await request('/auth/invitations/inspect', { method: 'POST', body: { token: pending.raw } })).status, 400);
    pending = await invite(owner, first.workspaceId, 'pending@example.test');
    await request(`/workspaces/${first.workspaceId}/invitations/${pending.id}`, { method: 'DELETE', actor: owner, body: {} });
    assert.equal((await request('/auth/invitations/inspect', { method: 'POST', body: { token: pending.raw } })).status, 400);
    const concurrent = await invite(owner, first.workspaceId, 'concurrent@example.test');
    const result = await Promise.all(
      [1, 2].map(() => request('/auth/invitations/accept', { method: 'POST', body: { token: concurrent.raw, name: 'Concurrent', password: secondPassword } })),
    );
    assert.deepEqual(result.map(r => r.status).sort(), [201, 400]);
  });
  await t.test('audit and delivery status contain no credentials or raw tokens', async () => {
    const audit = await request(`/workspaces/${first.workspaceId}/audit`, { actor: owner });
    assert.equal(audit.status, 200);
    assert.ok(audit.data.some(e => e.action === 'invitation.accepted'));
    const delivery = await request(`/workspaces/${first.workspaceId}/mail-status`, { actor: owner });
    assert.ok(delivery.data.some(e => e.sent_at));
    assert.doesNotMatch(JSON.stringify([audit.data, delivery.data]), /password_hash|token_hash|#invite|csrf_token/);
    assert.equal((await pool.query("SELECT count(*) FROM mail_outbox WHERE sent_at IS NOT NULL AND body<>''")).rows[0].count, '0');
  });
  await t.test('reset responses hide account existence, reset once and revoke every old session', async () => {
    const missing = await request('/auth/forgot-password', { method: 'POST', body: { email: 'nobody@example.test' } });
    const present = await request('/auth/forgot-password', { method: 'POST', body: { email: 'member@example.test' } });
    assert.deepEqual(missing.data, present.data);
    assert.equal(present.status, 202);
    await drain();
    const reset = messages.findLast(m => m.recipient === 'member@example.test').body.match(/#reset=([a-f0-9]{64})/)[1];
    assert.equal((await request('/auth/reset-password', { method: 'POST', body: { token: reset, password: 'short' } })).status, 400);
    const result = await request('/auth/reset-password', { method: 'POST', body: { token: reset, password: secondPassword } });
    assert.equal(result.status, 200);
    assert.equal((await request('/auth/me', { actor: member })).status, 401);
    assert.equal((await request('/auth/reset-password', { method: 'POST', body: { token: reset, password: memberPassword } })).status, 400);
    member = await login('member@example.test', secondPassword);
  });
  await t.test('revoked pending mail is suppressed; transient delivery failures are retried', async () => {
    const response = await request(`/workspaces/${first.workspaceId}/invitations`, { method: 'POST', actor: owner, body: { email: 'mail@example.test' } });
    assert.equal(response.status, 201);
    await deliverOne(pool, async () => {
      throw new Error('Simulated SMTP failure');
    });
    let row = (await pool.query('SELECT attempts,next_attempt_at,sent_at FROM mail_outbox WHERE invitation_id=$1', [response.data.id])).rows[0];
    assert.equal(row.attempts, 1);
    assert.equal(row.sent_at, null);
    await request(`/workspaces/${first.workspaceId}/invitations/${response.data.id}`, { method: 'DELETE', actor: owner, body: {} });
    await pool.query('UPDATE mail_outbox SET next_attempt_at=now() WHERE invitation_id=$1', [response.data.id]);
    let delivered = false;
    await deliverOne(pool, async () => {
      delivered = true;
    });
    assert.equal(delivered, false);
    assert.equal((await pool.query('SELECT 1 FROM mail_outbox WHERE invitation_id=$1', [response.data.id])).rowCount, 0);
  });
  await t.test('expired sessions, logout and restarted application do not bypass authentication', async () => {
    await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [digest(member.cookie.split('=')[1])]);
    assert.equal((await request('/auth/me', { actor: member })).status, 401);
    const restarted = await createApp(pool, config);
    const second = restarted.listen(0, '127.0.0.1');
    await new Promise(resolve => second.once('listening', resolve));
    try {
      const result = await fetch(`http://127.0.0.1:${second.address().port}/api/auth/me`, { headers: { cookie: owner.cookie } });
      assert.equal(result.status, 200);
      assert.ok((await result.json()).workspaces.some(w => w.name === 'Nama tim baru'));
    } finally {
      await new Promise(resolve => second.close(resolve));
    }
    assert.equal((await request('/auth/logout', { method: 'POST', actor: owner, body: {} })).status, 204);
    assert.equal((await request('/auth/me', { actor: owner })).status, 401);
  });
  await t.test('database-backed rate limit survives a new application instance', async () => {
    let result;
    for (let i = 0; i < 11; i++) result = await request('/auth/login', { method: 'POST', body: { email: 'rate@example.test', password: 'incorrect' } });
    assert.equal(result.status, 429);
    const restarted = await createApp(pool, config);
    const second = restarted.listen(0, '127.0.0.1');
    await new Promise(resolve => second.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${second.address().port}/api/auth/login`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'rate@example.test', password: 'incorrect' }),
      });
      assert.equal(response.status, 429);
    } finally {
      await new Promise(resolve => second.close(resolve));
    }
  });
  await t.test('production uses Secure __Host cookies and security headers', async () => {
    const production = readConfig({
      NODE_ENV: 'production',
      DATABASE_URL: url.toString(),
      APP_ORIGIN: 'https://workspace.example.test',
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.example.test',
    });
    const productionApp = await createApp(pool, production);
    const listener = productionApp.listen(0, '127.0.0.1');
    await new Promise(resolve => listener.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/auth/login`, {
        method: 'POST',
        headers: { origin: production.APP_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'admin@example.test', password: secondPassword }),
      });
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie');
      assert.match(cookie, /^__Host-sultan_session=/);
      assert.match(cookie, /; Secure;/);
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /Path=\//);
      assert.doesNotMatch(cookie, /Domain=/i);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.ok(response.headers.get('strict-transport-security'));
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    } finally {
      await new Promise(resolve => listener.close(resolve));
    }
  });
});

test('production configuration refuses insecure origins and development mail', () => {
  assert.throws(
    () =>
      readConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://localhost/db',
        APP_ORIGIN: 'http://localhost:5173',
        MAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'smtp.example.test',
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      readConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://localhost/db', APP_ORIGIN: 'https://workspace.example.test', MAIL_TRANSPORT: 'file' }),
    /SMTP/,
  );
  const config = readConfig({ DATABASE_URL: 'postgresql://user:password@db.example.test/postgres?sslmode=disable' });
  assert.equal(config.database.ssl.rejectUnauthorized, true);
  assert.equal(new URL(config.database.connectionString).searchParams.has('sslmode'), false);
});
