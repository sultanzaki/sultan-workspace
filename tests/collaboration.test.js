import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, migrate, transaction } from '../server/db.js';
import { bootstrap } from '../server/bootstrap.js';
import { hashPassword } from '../server/security.js';
import { createApp } from '../server/app.js';
import { nextRecurringDate, dueReminders } from '../server/automations.js';
import { testConfig } from './database.js';

test('calendar recurrence preserves month anchors, leap days and weekly intervals', () => {
  assert.equal(nextRecurringDate('2027-01-31', 'Monthly'), '2027-02-28');
  assert.equal(nextRecurringDate('2027-02-28', 'Monthly', 31), '2027-03-31');
  assert.equal(nextRecurringDate('2028-01-31', 'Monthly'), '2028-02-29');
  assert.equal(nextRecurringDate('2028-02-29', 'Monthly', 31), '2028-03-31');
  assert.equal(nextRecurringDate('2027-12-31', 'Daily'), '2028-01-01');
  assert.equal(nextRecurringDate('2027-12-31', 'Weekly'), '2028-01-07');
  assert.equal(nextRecurringDate('2027-12-31', 'Every 2 weeks'), '2028-01-14');
});
test('collaboration and automation persist real content with private access and idempotency', async t => {
  const config = testConfig(),
    pool = createPool(config);
  await pool.query('DROP SCHEMA IF EXISTS app_private CASCADE');
  await migrate(pool);
  const first = await bootstrap(pool, { email: 'owner@example.test', name: 'Owner', workspace: 'Collaboration', password: 'owner-test-password-123' });
  const member = randomUUID(),
    outside = randomUUID(),
    otherWs = randomUUID();
  for (const [id, name] of [
    [member, 'Member'],
    [outside, 'Outside'],
  ])
    await pool.query('INSERT INTO users(id,email,name,password_hash,email_verified_at) VALUES ($1,$2,$3,$4,now())', [
      id,
      name.toLowerCase() + '@example.test',
      name,
      await hashPassword('member-test-password-123'),
    ]);
  await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,'member')", [first.workspaceId, member]);
  await pool.query("INSERT INTO workspaces(id,name) VALUES ($1,'Other')", [otherWs]);
  await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,'owner')", [otherWs, outside]);
  const app = await createApp(pool, config),
    server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  });
  const base = `http://127.0.0.1:${server.address().port}/api`,
    prefix = `/workspaces/${first.workspaceId}`;
  async function call(path, actor, method = 'GET', body) {
    if (method === 'DELETE') body = {};
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json', origin: config.APP_ORIGIN } : {}),
        ...(method === 'DELETE' ? { origin: config.APP_ORIGIN, 'content-type': 'application/json' } : {}),
        ...(actor ? { cookie: actor.cookie, 'x-csrf-token': actor.csrf } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = response.status === 204 ? null : await response.json();
    return { status: response.status, data };
  }
  async function login(email, password) {
    const response = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: config.APP_ORIGIN },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 200);
    const actor = { cookie: response.headers.get('set-cookie').split(';')[0] };
    actor.csrf = (await call('/auth/me', actor)).data.csrfToken;
    return actor;
  }
  const owner = await login('owner@example.test', 'owner-test-password-123'),
    user = await login('member@example.test', 'member-test-password-123'),
    stranger = await login('outside@example.test', 'member-test-password-123');
  const snapshot = async (actor = owner) => (await call(prefix + '/content', actor)).data;
  const project = (id, extra = {}) => ({
    id,
    key: id.toUpperCase(),
    name: id,
    icon: 'folder',
    color: 'indigo',
    status: 'active',
    team: '',
    lead: first.userId,
    due: null,
    start: null,
    fav: false,
    members: [first.userId],
    desc: '',
    milestones: [],
    last: 0,
    ...extra,
  });
  const task = (id, p = 'public', extra = {}) => ({
    id,
    key: p.toUpperCase() + '-' + id,
    project: p,
    title: id,
    status: 'todo',
    assignee: member,
    priority: 'medium',
    due: null,
    start: null,
    labels: [],
    subtasks: [],
    attachments: [],
    deps: [],
    desc: '',
    estimate: null,
    created: 1,
    updated: 1,
    order: 1,
    fav: false,
    recur: null,
    ...extra,
  });
  const op = (entity, value) => ({ entity, id: value.id, value });
  async function write(operations, actor = owner, extra = {}) {
    return call(prefix + '/content', actor, 'POST', { revision: (await snapshot(actor)).revision, mutationId: randomUUID(), operations, ...extra });
  }
  const setup = await write([
    op('project', project('public')),
    op('project', project('private', { private: true })),
    op('task', task('publicTask')),
    op('task', task('privateTask', 'private')),
  ]);
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  let comment, file;
  await t.test('comments, mentions and reactions persist; author identity and private access are enforced', async () => {
    const input = { id: randomUUID(), text: '@Owner please review <script>bad()</script>', mentions: [first.userId] };
    const created = await call(prefix + '/tasks/publicTask/comments', user, 'POST', input);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    comment = created.data;
    assert.equal(comment.by, member);
    assert.equal(comment.text, input.text);
    assert.equal((await call(prefix + '/tasks/publicTask/comments', user, 'POST', input)).status, 201);
    assert.equal((await pool.query('SELECT count(*) FROM task_comments WHERE id=$1', [comment.id])).rows[0].count, '1');
    assert.equal((await call(prefix + '/tasks/publicTask/comments', user, 'POST', { ...input, text: 'different' })).status, 409);
    assert.equal((await call(prefix + '/tasks/privateTask/comments', user, 'POST', { ...input, id: randomUUID() })).status, 404);
    assert.equal((await call(prefix + '/tasks/publicTask/comments', stranger)).status, 404);
    assert.equal((await call(prefix + '/tasks/publicTask/comments', user, 'POST', { ...input, id: randomUUID(), author: first.userId })).status, 400);
    assert.equal((await call(prefix + '/tasks/publicTask/comments', user, 'POST', { id: randomUUID(), text: '@Outside', mentions: [outside] })).status, 400);
    const notifications = (await snapshot()).notifs.filter(n => n.type === 'mention' && n.task === 'publicTask');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].by, member);
    assert.equal((await call(prefix + `/comments/${comment.id}`, owner, 'PATCH', { text: 'forged', mentions: [], version: 1 })).status, 403);
    const edited = await call(prefix + `/comments/${comment.id}`, user, 'PATCH', { text: 'Edited comment', mentions: [], version: 1 });
    assert.equal(edited.status, 200);
    comment = edited.data;
    assert.equal(comment.version, 2);
    assert.ok(comment.editedAt);
    const racing = await Promise.all(
      ['first', 'second'].map(text => call(prefix + `/comments/${comment.id}`, user, 'PATCH', { text, mentions: [], version: 2 })),
    );
    assert.deepEqual(racing.map(r => r.status).sort(), [200, 409]);
    for (const actor of [owner, user, user])
      assert.equal((await call(prefix + `/comments/${comment.id}/reactions`, actor, 'POST', { emoji: '👍', present: true })).status, 200);
    let loaded = (await call(prefix + '/tasks/publicTask/comments', owner)).data.comments.find(c => c.id === comment.id);
    assert.deepEqual(new Set(loaded.re['👍']), new Set([first.userId, member]));
    await call(prefix + `/comments/${comment.id}/reactions`, user, 'POST', { emoji: '👍', present: false });
    loaded = (await call(prefix + '/tasks/publicTask/comments', owner)).data.comments[0];
    assert.deepEqual(loaded.re['👍'], [first.userId]);
  });
  await t.test('file downloads return original bytes, not generated previews; metadata cannot forge attachments', async () => {
    const bytes = Buffer.from('private file contents\n日本語\n'),
      input = { id: randomUUID(), project: 'public', task: 'publicTask', name: 'notes.txt', content: bytes.toString('base64') };
    const uploaded = await call(prefix + '/files', user, 'POST', input);
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
    file = uploaded.data;
    assert.equal(file.bytes, bytes.length);
    assert.equal(file.task, 'publicTask');
    assert.ok(!('content' in file));
    assert.equal((await call(prefix + '/files', user, 'POST', input)).data.id, file.id);
    const response = await fetch(base + file.url.slice('/api'.length), { headers: { cookie: owner.cookie } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const forged = await write([
      op('task', { ...(await snapshot()).tasks.find(t => t.id === 'publicTask'), attachments: [{ id: 'fake', url: 'https://evil.test/' }] }),
    ]);
    assert.equal(forged.status, 200);
    assert.deepEqual(
      forged.data.tasks.find(t => t.id === 'publicTask').attachments.map(f => f.id),
      [file.id],
    );
    assert.equal((await call(prefix + `/files/${file.id}/download`, stranger)).status, 404);
    assert.equal((await call(prefix + '/files', user, 'POST', { ...input, id: randomUUID(), project: 'private', task: 'privateTask' })).status, 404);
    assert.equal((await call(prefix + '/files', user, 'POST', { ...input, id: randomUUID(), name: '../secret' })).status, 400);
    assert.equal((await call(prefix + '/files', user, 'POST', { ...input, id: randomUUID(), content: 'invalid!!' })).status, 400);
    const html = await call(prefix + '/files', user, 'POST', {
      ...input,
      id: randomUUID(),
      name: 'fake.png',
      content: Buffer.from('<svg onload=alert(1)>').toString('base64'),
    });
    assert.equal(html.status, 201);
    assert.equal(html.data.preview, null);
    assert.equal(html.data.mime, 'application/octet-stream');
    assert.equal((await call(prefix + `/files/${html.data.id}/preview`, owner)).status, 415);
    const renamed = await call(prefix + `/files/${file.id}`, user, 'PATCH', { name: 'renamed.txt' });
    assert.equal(renamed.data.name, 'renamed.txt');
    const copyId = randomUUID(),
      copy = await call(prefix + `/files/${file.id}/copy`, user, 'POST', { id: copyId });
    assert.equal(copy.status, 201);
    assert.equal(copy.data.bytes, file.bytes);
    assert.equal((await call(prefix + `/files/${file.id}/copy`, user, 'POST', { id: copyId })).data.id, copyId);
    assert.equal((await call(prefix + `/files/${copyId}`, owner, 'DELETE')).status, 204);
    assert.equal((await call(prefix + `/files/${copyId}/download`, owner)).status, 404);
  });
  await t.test('moving a task also moves private comments, files and notifications to the new access boundary', async () => {
    const current = (await snapshot()).tasks.find(t => t.id === 'publicTask');
    const moved = await write([op('task', { ...current, project: 'private', key: 'PRIVATE-publicTask' })]);
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
    const visible = await snapshot(user);
    assert.ok(!visible.comments.some(c => c.task === 'publicTask'));
    assert.ok(!visible.files.some(f => f.id === file.id));
    assert.ok(!visible.notifs.some(n => n.task === 'publicTask'));
    assert.equal((await call(prefix + `/files/${file.id}/download`, user)).status, 404);
    assert.equal((await call(prefix + `/comments/${comment.id}/reactions`, user, 'POST', { emoji: '👍', present: true })).status, 404);
    const restored = await write([op('task', { ...moved.data.tasks.find(t => t.id === 'publicTask'), project: 'public', key: 'PUBLIC-publicTask' })]);
    assert.equal(restored.status, 200);
  });
  await t.test('notification read state and category preferences are isolated per account', async () => {
    const notification = (await snapshot(user)).notifs.find(n => n.type === 'assign');
    assert.ok(notification);
    await call(prefix + '/notifications/read', owner, 'POST', { ids: [notification.id], read: true });
    assert.equal((await snapshot(user)).notifs.find(n => n.id === notification.id).read, false);
    await call(prefix + '/notifications/read', user, 'POST', { all: true, read: true });
    assert.ok((await snapshot(user)).notifs.every(n => n.read));
    const prefs = await write([], user, { preferences: { notifPrefs: { push_comment: false, push_mention: false, push_due: false } } });
    assert.equal(prefs.status, 200);
    const muted = await call(prefix + '/tasks/publicTask/comments', owner, 'POST', { id: randomUUID(), text: '@Member muted mention', mentions: [member] });
    assert.equal(muted.status, 201);
    assert.ok(!(await snapshot(user)).notifs.some(n => n.snippet === '@Member muted mention'));
    assert.deepEqual((await snapshot(owner)).preferences.notifPrefs, undefined);
    await write([], user, { preferences: { notifPrefs: { push_comment: true, push_mention: true, push_due: true } } });
  });
  await t.test('monthly completion creates exactly one next occurrence and retries/reopening cannot duplicate it', async () => {
    let source = task('repeating', 'public', {
      key: 'PUBLIC-300',
      recur: 'Monthly',
      due: '2037-01-31',
      start: '2037-01-29',
      subtasks: [{ id: 'sub', title: 'Repeat checklist', done: true, due: '2037-01-30' }],
    });
    assert.equal((await write([op('task', source)])).status, 200);
    source = (await snapshot()).tasks.find(t => t.id === 'repeating');
    const revision = (await snapshot()).revision,
      mutationId = randomUUID(),
      input = { revision, mutationId, operations: [op('task', { ...source, status: 'done' })] };
    const completed = await call(prefix + '/content', owner, 'POST', input);
    assert.equal(completed.status, 200, JSON.stringify(completed.data));
    const next = completed.data.tasks.find(t => t.id !== 'repeating' && t.recur === 'Monthly');
    assert.ok(next);
    assert.equal(next.due, '2037-02-28');
    assert.equal(next.start, '2037-02-26');
    assert.equal(next.subtasks[0].done, false);
    assert.equal(next.subtasks[0].due, '2037-02-27');
    assert.equal((await call(prefix + '/content', owner, 'POST', input)).status, 200);
    assert.equal((await snapshot()).tasks.filter(t => t.recur === 'Monthly').length, 2);
    assert.equal((await write([op('task', { ...source, status: 'todo' })])).status, 200);
    assert.equal((await write([op('task', { ...source, status: 'done' })])).status, 200);
    assert.equal((await snapshot()).tasks.filter(t => t.recur === 'Monthly').length, 2);
    const second = await write([op('task', { ...next, status: 'done' })]);
    assert.equal(second.status, 200);
    assert.ok(second.data.tasks.some(t => t.recur === 'Monthly' && t.due === '2037-03-31'));
    assert.equal((await write([op('task', task('invalidRecur', 'public', { recur: 'Daily' }))])).status, 400);
  });
  await t.test('deadline jobs are idempotent, honor preferences and never notify inaccessible users', async () => {
    assert.equal(
      (await write([op('task', task('deadline', 'public', { due: '2035-06-11' })), op('task', task('hiddenDeadline', 'private', { due: '2035-06-11' }))]))
        .status,
      200,
    );
    const run = () =>
      transaction(pool, async db => {
        await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [first.workspaceId]);
        return dueReminders(db, first.workspaceId, { now: new Date('2035-06-10T12:00:00Z'), force: true });
      });
    const counts = await Promise.all([run(), run()]);
    assert.equal(
      counts.reduce((a, b) => a + b, 0),
      1,
    );
    const reminders = (await snapshot(user)).notifs.filter(n => n.task === 'deadline');
    assert.equal(reminders.length, 2);
    assert.equal(reminders.filter(n => n.by === null).length, 1);
    assert.ok(!(await snapshot(user)).notifs.some(n => n.task === 'hiddenDeadline'));
    await write([], user, { preferences: { notifPrefs: { push_due: false } } });
    await transaction(pool, db => dueReminders(db, first.workspaceId, { now: new Date('2035-06-11T12:00:00Z'), force: true }));
    assert.equal((await snapshot(user)).notifs.filter(n => n.task === 'deadline' && n.by === null).length, 1);
  });
  await t.test('comment history is paginated and author/admin deletes remove dependent notifications', async () => {
    for (let i = 0; i < 52; i++)
      await pool.query(
        "INSERT INTO task_comments(id,workspace_id,project_id,task_id,author_id,body,created_at) VALUES ($1,$2,$3,$4,$5,$6,now()+$7*interval '1 second')",
        [randomUUID(), first.workspaceId, 'public', 'publicTask', member, 'history ' + i, i],
      );
    const firstPage = await call(prefix + '/tasks/publicTask/comments', user);
    assert.equal(firstPage.data.comments.length, 50);
    assert.ok(firstPage.data.nextCursor);
    const secondPage = await call(prefix + '/tasks/publicTask/comments?cursor=' + firstPage.data.nextCursor, user);
    assert.ok(secondPage.data.comments.length > 0);
    assert.equal(secondPage.data.nextCursor, null);
    assert.ok(!secondPage.data.comments.some(c => firstPage.data.comments.some(a => a.id === c.id)));
    assert.equal((await call(prefix + `/comments/${comment.id}`, owner, 'DELETE')).status, 204);
    assert.ok(!(await snapshot()).comments.some(c => c.id === comment.id));
    assert.equal((await pool.query('SELECT count(*) FROM user_notifications WHERE comment_id=$1', [comment.id])).rows[0].count, '0');
  });
});
