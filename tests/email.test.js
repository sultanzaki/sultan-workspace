import { createMaintenance } from '../server/maintenance.js';
import { initializationDiagnostic } from '../server/diagnostics.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { createPool, migrate, transaction } from '../server/db.js';
import { bootstrap } from '../server/bootstrap.js';
import { createApp } from '../server/app.js';
import { hashPassword } from '../server/security.js';
import { readConfig } from '../server/config.js';
import { createMailer, deliverOne, queueSecurityMail } from '../server/mail.js';
import { queueEmailJobs } from '../server/email-jobs.js';
import { notifyMany } from '../server/content-access.js';
import { verifyResendSignature } from '../server/email-routes.js';
import { testConfig } from './database.js';

test('Resend transport uses a stable idempotency key and never exposes provider errors or credentials', async () => {
  const config = { MAIL_TRANSPORT: 'resend', MAIL_FROM: 'sender@example.test', RESEND_API_KEY: 'test-key-not-for-deployment' },
    mail = {
      id: randomUUID(),
      recipient: 'to@example.test',
      subject: 'Hello',
      body: 'Text',
      html: '<p>Text</p>',
      headers: {},
      context: { sender: 'original@example.test' },
    };
  const requests = [];
  const send = createMailer(config, {
    fetchImpl: async (url, request) => {
      requests.push({ url, ...request });
      return new Response(JSON.stringify({ id: 'provider-1' }), { status: 200 });
    },
  });
  await send(mail);
  await send(mail);
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  assert.equal(requests[0].headers['Idempotency-Key'], requests[1].headers['Idempotency-Key']);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(JSON.parse(requests[0].body).from, 'original@example.test');
  const failed = createMailer(config, { fetchImpl: async () => new Response('private-provider-detail', { status: 429 }) });
  await assert.rejects(failed(mail), error => error.code === 'rate_limited' && !error.message.includes('private-provider-detail'));
  const permanent = createMailer(config, { fetchImpl: async () => new Response('private', { status: 422 }) });
  await assert.rejects(permanent(mail), error => error.permanent === true);
  const env = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://localhost/test',
    APP_ORIGIN: 'https://app.example.test',
    MAIL_FROM: 'sender@example.test',
    RESEND_API_KEY: 'test-key-not-for-deployment',
  };
  assert.equal(readConfig(env).MAIL_TRANSPORT, 'resend');
  assert.equal(readConfig({ ...env, SMTP_USER: 'unused-smtp-user' }).MAIL_TRANSPORT, 'resend');
  assert.match(initializationDiagnostic({ code: 'MAIL_FROM_REQUIRED' }).message, /MAIL_FROM/);
  assert.match(initializationDiagnostic({ code: 'RESEND_KEY_REQUIRED' }).message, /RESEND_API_KEY/);
  assert.throws(
    () => readConfig({ ...env, RESEND_API_KEY: undefined, MAIL_TRANSPORT: 'resend' }),
    error => error.code === 'RESEND_KEY_REQUIRED',
  );
  assert.throws(
    () => readConfig({ ...env, MAIL_FROM: undefined }),
    error => error.code === 'MAIL_FROM_REQUIRED',
  );
});

test('email jobs honor independent preferences, current permissions, idempotency, digest slots, unsubscribe and signed delivery reports', async t => {
  const config = { ...testConfig(), RESEND_WEBHOOK_SECRET: 'whsec_' + Buffer.alloc(32, 8).toString('base64') },
    pool = createPool(config);
  await pool.query('DROP SCHEMA IF EXISTS app_private CASCADE');
  await migrate(pool);
  await migrate(pool);
  const password = 'email-test-password-123',
    first = await bootstrap(pool, { email: 'owner@example.test', name: 'Owner', workspace: 'Email Team', password }),
    userId = randomUUID();
  await pool.query('INSERT INTO users(id,email,name,password_hash,email_verified_at) VALUES ($1,$2,$3,$4,now())', [
    userId,
    'member@example.test',
    '<img src=x onerror=evil()>',
    await hashPassword(password),
  ]);
  await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,'member')", [first.workspaceId, userId]);
  const project = { id: 'email-project', key: 'MAIL', name: 'Private <project>', members: [first.userId, userId], lead: first.userId, private: false };
  const task = { id: 'email-task', project: project.id, title: 'Task <script>evil()</script>', assignee: userId, status: 'todo', due: '2037-04-01' };
  await pool.query('INSERT INTO projects(workspace_id,id,data) VALUES ($1,$2,$3)', [first.workspaceId, project.id, project]);
  await pool.query('INSERT INTO tasks(workspace_id,id,project_id,data) VALUES ($1,$2,$3,$4)', [first.workspaceId, task.id, project.id, task]);
  const app = await createApp(pool, config),
    server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  });
  const base = `http://127.0.0.1:${server.address().port}/api`,
    ws = '/workspaces/' + first.workspaceId;
  async function request(path, actor, method = 'GET', body, headers = {}) {
    const r = await fetch(base + path, {
      method,
      headers: {
        ...(method === 'GET' ? {} : { origin: config.APP_ORIGIN, 'content-type': 'application/json' }),
        ...(actor ? { cookie: actor.cookie, 'x-csrf-token': actor.csrf } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: r.status === 204 ? null : await r.json(), headers: r.headers };
  }
  async function login(email, passwordValue = password) {
    const result = await request('/auth/login', null, 'POST', { email, password: passwordValue });
    assert.equal(result.status, 200);
    const actor = { cookie: result.headers.get('set-cookie').split(';')[0] };
    actor.csrf = (await request('/auth/me', actor)).data.csrfToken;
    return actor;
  }
  const owner = await login('owner@example.test'),
    user = await login('member@example.test');
  async function prefs(notifPrefs, extra = {}) {
    await pool.query(
      'INSERT INTO workspace_preferences(workspace_id,user_id,data) VALUES ($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO UPDATE SET data=EXCLUDED.data',
      [first.workspaceId, userId, { notifPrefs, ...extra }],
    );
  }
  async function clear() {
    await pool.query('DELETE FROM mail_outbox');
    await pool.query('DELETE FROM email_events');
    await pool.query('DELETE FROM email_digest_runs');
    await prefs({});
  }
  async function event(category = 'assign') {
    const comment = ['mention', 'comment'].includes(category) ? randomUUID() : null;
    if (comment)
      await pool.query('INSERT INTO task_comments(id,workspace_id,project_id,task_id,author_id,body,mentions) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
        comment,
        first.workspaceId,
        project.id,
        task.id,
        first.userId,
        'Comment <b>text</b>',
        category === 'mention' ? [userId] : [],
      ]);
    const key = category === 'due' ? `deadline:${task.id}:${task.due}:today` : 'email-test:' + randomUUID();
    await transaction(pool, db =>
      notifyMany(db, [
        {
          workspace: first.workspaceId,
          recipient: userId,
          actor: first.userId,
          project,
          task: task.id,
          comment,
          kind: ['status', 'due'].includes(category) ? 'update' : category,
          ...(['status', 'due'].includes(category) ? { preference: 'push_' + category } : {}),
          message: 'Task updated',
          snippet: '<img src=x onerror=evil()>',
          event: key,
        },
      ]),
    );
    return (await pool.query('SELECT * FROM email_events WHERE event_key=$1', [key])).rows[0];
  }
  const sent = [];
  const collect = async mail => {
    sent.push(structuredClone(mail));
    return { id: 'test-provider:' + mail.id };
  };
  async function drain(deliver = collect) {
    for (let i = 0; i < 30; i++) if (!(await deliverOne(pool, deliver, config))) break;
  }
  await t.test('email and in-app preferences work independently, with templates escaping untrusted text', async () => {
    await clear();
    await prefs({ push_assign: false, email_assign: true });
    const e = await event();
    assert.equal((await pool.query('SELECT 1 FROM user_notifications WHERE event_key=$1', [e.event_key])).rowCount, 0);
    await queueEmailJobs(pool);
    await queueEmailJobs(pool);
    assert.equal((await pool.query("SELECT 1 FROM mail_outbox WHERE kind='notification'")).rowCount, 1);
    await drain();
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /#task=email-task/);
    assert.match(sent[0].html, /&lt;script&gt;/);
    assert.doesNotMatch(sent[0].html, /<script>|<img src=x/);
    assert.equal((await pool.query('SELECT body,html FROM mail_outbox')).rows[0].body, '');
    assert.equal((await pool.query('SELECT body,html FROM mail_outbox')).rows[0].html, '');
    await clear();
    await prefs({ push_mention: true, email_mention: false });
    const mention = await event('mention');
    await queueEmailJobs(pool);
    await drain();
    assert.equal(sent.length, 1);
    assert.equal((await pool.query('SELECT 1 FROM user_notifications WHERE event_key=$1', [mention.event_key])).rowCount, 1);
  });
  await t.test('all configured activity types can generate real emails without relying on push categories', async () => {
    await clear();
    await prefs({ email_mention: true, email_assign: true, email_comment: true, email_status: true, email_due: true });
    const before = sent.length;
    for (const category of ['mention', 'assign', 'comment', 'status', 'due']) await event(category);
    await queueEmailJobs(pool);
    await drain();
    assert.equal(sent.length - before, 5);
    assert.ok(sent.slice(before).every(m => m.html.includes('Berhenti berlangganan')));
  });
  await t.test('concurrent workers and retries reuse a frozen payload; changes in access or preference cancel queued mail', async () => {
    await clear();
    await event();
    await queueEmailJobs(pool);
    let captured;
    await deliverOne(
      pool,
      async mail => {
        captured = structuredClone(mail);
        throw new Error('lost acknowledgement');
      },
      config,
    );
    const frozen = (await pool.query('SELECT * FROM mail_outbox')).rows[0];
    assert.ok(frozen.rendered_at);
    assert.equal(frozen.attempts, 1);
    assert.equal(frozen.body, captured.body);
    await pool.query("UPDATE tasks SET data=jsonb_set(data,'{title}','\"New task title\"') WHERE id=$1", [task.id]);
    await pool.query('UPDATE mail_outbox SET next_attempt_at=now()');
    const before = sent.length;
    await Promise.all([deliverOne(pool, collect, config), deliverOne(pool, collect, config)]);
    assert.equal(sent.length - before, 1);
    assert.equal(sent.at(-1).body, captured.body);
    assert.deepEqual(sent.at(-1).headers, captured.headers);
    await clear();
    await event();
    await queueEmailJobs(pool);
    await prefs({ email_assign: false });
    await drain();
    assert.equal(sent.length - before, 1);
    assert.equal((await pool.query('SELECT delivery_status FROM mail_outbox')).rows[0].delivery_status, 'cancelled');
    await clear();
    await event();
    await queueEmailJobs(pool);
    await pool.query("UPDATE projects SET data=jsonb_set(jsonb_set(data,'{private}','true'),'{members}',$1) WHERE id=$2", [
      JSON.stringify([first.userId]),
      project.id,
    ]);
    await drain();
    assert.equal(sent.length - before, 1);
    await pool.query('UPDATE projects SET data=$1 WHERE id=$2', [project, project.id]);
  });
  await t.test('permanent failures and the final retry stop delivery and erase sensitive envelopes', async () => {
    await clear();
    await event();
    await queueEmailJobs(pool);
    await deliverOne(
      pool,
      async () => {
        throw Object.assign(new Error('Invalid recipient'), { permanent: true, code: 'provider_rejected' });
      },
      config,
    );
    let row = (await pool.query('SELECT * FROM mail_outbox')).rows[0];
    assert.equal(row.delivery_status, 'failed');
    assert.equal(row.attempts, 1);
    assert.equal(row.body, '');
    assert.equal(row.html, '');
    assert.equal(await deliverOne(pool, collect, config), false);
    await clear();
    await event();
    await queueEmailJobs(pool);
    await pool.query('UPDATE mail_outbox SET attempts=7');
    await deliverOne(
      pool,
      async () => {
        throw new Error('Still unavailable');
      },
      config,
    );
    row = (await pool.query('SELECT * FROM mail_outbox')).rows[0];
    assert.equal(row.attempts, 8);
    assert.equal(row.delivery_status, 'failed');
    assert.equal(row.body, '');
    assert.deepEqual(row.context, {});
  });
  await t.test('opt-in weekday digests include weekend activity once, and never expose a project revoked before delivery', async () => {
    await clear();
    await prefs({ email_assign: false, email_digest: true }, { prefs: { tz: 'Asia/Jakarta' } });
    const e = await event();
    await pool.query("UPDATE email_events SET created_at='2037-03-07T12:00:00Z' WHERE id=$1", [e.id]);
    await pool.query(
      "INSERT INTO email_digest_runs(workspace_id,user_id,period_end,weekday) VALUES ($1,$2,'2037-03-06T00:15:00Z',true),($1,$2,'2037-03-08T00:15:00Z',false)",
      [first.workspaceId, userId],
    );
    const run = () => queueEmailJobs(pool, { now: new Date('2037-03-09T04:00:00Z') });
    await run();
    await run();
    const queued = (await pool.query("SELECT * FROM mail_outbox WHERE kind='digest'")).rows;
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].context.events, [e.id]);
    const before = sent.length;
    await drain();
    assert.equal(sent.length - before, 1);
    assert.match(sent.at(-1).subject, /Ringkasan harian/);
    await clear();
    await prefs({ email_assign: false, email_digest: true }, { prefs: { tz: 'Asia/Jakarta' } });
    const hidden = await event();
    await pool.query("UPDATE email_events SET created_at='2037-03-08T12:00:00Z' WHERE id=$1", [hidden.id]);
    await run();
    await pool.query('UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2', [userId, first.workspaceId]);
    await drain();
    assert.equal(sent.length - before, 1);
    await pool.query('UPDATE memberships SET active=true WHERE user_id=$1 AND workspace_id=$2', [userId, first.workspaceId]);
  });
  await t.test('unsubscribe requires confirmation and preserves unrelated preferences; security emails remain available', async () => {
    await clear();
    await prefs({ email_assign: true, push_assign: false }, { prefs: { theme: 'dark' } });
    await event();
    await queueEmailJobs(pool);
    await drain();
    const link = sent.at(-1).body.match(/#unsubscribe=([a-f0-9]{64})/)[1];
    assert.equal((await request('/email/unsubscribe/inspect', null, 'POST', { token: link })).status, 200);
    assert.equal((await pool.query('SELECT data FROM workspace_preferences WHERE user_id=$1', [userId])).rows[0].data.notifPrefs.email_assign, true);
    assert.equal((await request('/email/unsubscribe', null, 'POST', { token: 'a'.repeat(64) })).status, 400);
    assert.equal((await request('/email/unsubscribe', null, 'POST', { token: link })).status, 200);
    const saved = (await pool.query('SELECT data FROM workspace_preferences WHERE user_id=$1', [userId])).rows[0].data;
    assert.equal(saved.prefs.theme, 'dark');
    assert.equal(saved.notifPrefs.push_assign, false);
    assert.equal(saved.notifPrefs.email_assign, false);
    assert.equal(saved.notifPrefs.email_digest, false);
    const before = sent.length;
    await event();
    await queueEmailJobs(pool);
    await drain();
    assert.equal(sent.length, before);
    const changed = await request('/account/password', user, 'POST', { currentPassword: password, newPassword: 'changed-email-password-123' });
    assert.equal(changed.status, 200);
    await drain();
    assert.equal(sent.length - before, 1);
    assert.equal(sent.at(-1).kind, 'security');
    assert.doesNotMatch(sent.at(-1).body, /changed-email-password-123|recovery.*[A-F0-9]{20}/);
  });
  await t.test('signed Resend webhooks track delivery and bounces, reject tampering and suppress further sends', async () => {
    await clear();
    await event();
    await queueEmailJobs(pool);
    await drain();
    const mail = sent.at(-1),
      providerId = 'test-provider:' + mail.id;
    async function webhook(type, { tamper = false, age = 0, id = randomUUID() } = {}) {
      const body = JSON.stringify({ type, data: { email_id: providerId } }),
        timestamp = String(Math.floor(Date.now() / 1000) - age);
      const signature = createHmac('sha256', Buffer.alloc(32, 8))
        .update(id + '.' + timestamp + '.' + body)
        .digest('base64');
      const response = await fetch(base + '/webhooks/resend', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': 'v1,' + (tamper ? 'invalid' : signature) },
        body,
      });
      return response.status;
    }
    assert.equal(await webhook('email.delivered', { tamper: true }), 401);
    assert.equal(await webhook('email.delivered', { age: 600 }), 401);
    await pool.query("UPDATE mail_outbox SET provider_id=NULL,finished_at=NULL,claim_token=$2,locked_until=now()+interval '1 minute' WHERE id=$1", [
      mail.id,
      randomUUID(),
    ]);
    assert.equal(await webhook('email.delivered'), 503);
    await pool.query('UPDATE mail_outbox SET provider_id=$2,finished_at=now(),claim_token=NULL,locked_until=NULL WHERE id=$1', [mail.id, providerId]);
    assert.equal(await webhook('email.delivered'), 200);
    assert.equal((await pool.query('SELECT delivery_status FROM mail_outbox WHERE id=$1', [mail.id])).rows[0].delivery_status, 'delivered');
    const id = randomUUID();
    assert.equal(await webhook('email.bounced', { id }), 200);
    assert.equal(await webhook('email.bounced', { id }), 200);
    assert.equal(await webhook('email.delivered'), 200);
    assert.equal((await pool.query('SELECT delivery_status FROM mail_outbox WHERE id=$1', [mail.id])).rows[0].delivery_status, 'bounced');
    assert.equal((await pool.query('SELECT 1 FROM email_suppressions WHERE recipient=$1', ['member@example.test'])).rowCount, 1);
    const before = sent.length;
    await event();
    await queueEmailJobs(pool);
    await drain();
    assert.equal(sent.length, before);
    await pool.query('DELETE FROM email_suppressions');
    assert.equal(verifyResendSignature(Buffer.from('{}'), {}, config.RESEND_WEBHOOK_SECRET), false);
  });
  await t.test('mail committed while maintenance is finishing gets a follow-up pass instead of waiting for the next visitor', async () => {
    await clear();
    let release,
      started,
      blocked = false;
    const gate = new Promise(resolve => (release = resolve)),
      ready = new Promise(resolve => (started = resolve));
    const proxy = {
      connect: () => pool.connect(),
      query: async (sql, args) => {
        if (!blocked && sql === 'DELETE FROM rate_limits WHERE expires_at < now()') {
          blocked = true;
          started();
          await gate;
        }
        return pool.query(sql, args);
      },
    };
    const maintain = createMaintenance(proxy, { ...config, serverless: true }, { deliver: collect }),
      firstRun = maintain();
    await ready;
    const before = sent.length;
    try {
      await transaction(pool, db => queueSecurityMail(db, config, userId, 'Concurrent security event'));
      const nextRun = maintain();
      release();
      await Promise.all([firstRun, nextRun]);
    } finally {
      release();
    }
    assert.equal(sent.length - before, 1);
    assert.match(sent.at(-1).body, /Concurrent security event/);
  });
  await t.test('admin delivery status hides email contents, and ordinary members cannot inspect or retry other mail', async () => {
    await event();
    await queueEmailJobs(pool);
    await drain();
    const response = await request(ws + '/mail-status', owner);
    assert.equal(response.status, 200);
    assert.ok(response.data.length);
    assert.ok(response.data.every(row => row.kind !== 'security' && row.kind !== 'reset'));
    assert.doesNotMatch(JSON.stringify(response.data), /#unsubscribe|<html>|token_hash|claim_token|test-key/);
    const member = await login('member@example.test', 'changed-email-password-123');
    assert.equal((await request(ws + '/mail-status', member)).status, 403);
    assert.equal((await request(ws + '/mail/' + randomUUID() + '/retry', member, 'POST', {})).status, 403);
    // The password change above intentionally revoked the member cookie.
    const other = await login('owner@example.test');
    const id = randomUUID();
    assert.equal((await request(ws + '/mail/' + id + '/retry', other, 'POST', {})).status, 409);
  });
});
