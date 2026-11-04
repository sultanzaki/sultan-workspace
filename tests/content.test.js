import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, migrate } from '../server/db.js';
import { bootstrap } from '../server/bootstrap.js';
import { hashPassword } from '../server/security.js';
import { createApp } from '../server/app.js';
import { testConfig } from './database.js';

test('shared projects/tasks have real persistence, authorization and conflict control', async t => {
  const config = testConfig(),
    pool = createPool(config);
  await pool.query('DROP SCHEMA IF EXISTS app_private CASCADE');
  await migrate(pool);
  const first = await bootstrap(pool, { email: 'owner@example.test', name: 'Owner', workspace: 'Team', password: 'owner-test-password-123' });
  const member = randomUUID(),
    outside = randomUUID(),
    otherWs = randomUUID();
  for (const [id, email] of [
    [member, 'member@example.test'],
    [outside, 'outside@example.test'],
  ])
    await pool.query('INSERT INTO users(id,email,name,password_hash,email_verified_at) VALUES ($1,$2,$2,$3,now())', [
      id,
      email,
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
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, actor, body) {
    const r = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { origin: config.APP_ORIGIN, 'content-type': 'application/json' } : {}),
        ...(actor ? { cookie: actor.cookie, 'x-csrf-token': actor.csrf } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json() };
  }
  async function login(email, password) {
    const r = await fetch(base + '/auth/login', {
      method: 'POST',
      headers: { origin: config.APP_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(r.status, 200);
    const actor = { cookie: r.headers.get('set-cookie').split(';')[0] };
    actor.csrf = (await request('/auth/me', actor)).data.csrfToken;
    return actor;
  }
  const owner = await login('owner@example.test', 'owner-test-password-123'),
    user = await login('member@example.test', 'member-test-password-123'),
    stranger = await login('outside@example.test', 'member-test-password-123');
  const path = `/workspaces/${first.workspaceId}/content`;
  const snapshot = async (actor = owner) => (await request(path, actor)).data;
  const project = (id = 'p1', extra = {}) => ({
    id,
    key: id.toUpperCase(),
    name: 'Project ' + id,
    icon: 'folder',
    color: 'indigo',
    status: 'planning',
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
  const task = (id = 't1', pid = 'p1', extra = {}) => ({
    id,
    key: pid.toUpperCase() + '-' + (id === 't1' ? 201 : 202),
    project: pid,
    title: 'Task ' + id,
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
  const operation = (entity, value) => ({ entity, id: value.id, value });
  async function write(actor, operations, options = {}) {
    return request(path, actor, {
      revision: options.revision ?? (await snapshot(actor)).revision,
      mutationId: options.mutationId || randomUUID(),
      operations,
      ...options,
    });
  }
  await t.test('public project and task are visible to another account; invalid tenant/assignee is rejected', async () => {
    assert.deepEqual((await snapshot()).projects, []);
    let r = await write(owner, [
      operation('project', project()),
      operation(
        'task',
        task('t1', 'p1', { desc: '<p>Safe</p><script>alert(1)</script><img src=x onerror=alert(1)>', subtasks: [{ id: 's1', title: 'Check', done: false }] }),
      ),
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await snapshot(user)).tasks[0].title, 'Task t1');
    assert.equal(r.data.tasks[0].desc, '<p>Safe</p>');
    assert.equal((await request(path, stranger)).status, 404);
    r = await write(user, [operation('task', task('t1', 'p1', { assignee: outside }))]);
    assert.equal(r.status, 400);
    assert.equal((await snapshot()).tasks[0].assignee, member);
  });
  await t.test('task status, order, dates, labels and subtask completion persist across reads', async () => {
    const current = (await snapshot()).tasks[0];
    const r = await write(user, [
      operation('task', {
        ...current,
        status: 'progress',
        order: 3.5,
        due: '2026-12-10',
        start: '2026-12-01',
        priority: 'urgent',
        labels: ['design'],
        subtasks: [{ id: 's1', title: 'Check', done: true, note: 'Actual note' }],
      }),
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const saved = (await snapshot()).tasks[0];
    assert.equal(saved.status, 'progress');
    assert.equal(saved.order, 3.5);
    assert.equal(saved.subtasks[0].done, true);
    assert.equal(saved.due, '2026-12-10');
    const invalid = await write(user, [operation('task', { ...saved, start: '2026-12-11' })]);
    assert.equal(invalid.status, 400);
    assert.equal((await snapshot()).tasks[0].start, '2026-12-01');
  });
  await t.test('private projects never leak through reads, task writes or saved views', async () => {
    const r = await write(owner, [
      operation('project', project('secret', { private: true })),
      operation('task', task('secretTask', 'secret', { assignee: first.userId })),
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(!(await snapshot(user)).projects.some(p => p.id === 'secret'));
    assert.ok(!(await snapshot(user)).tasks.some(t => t.id === 'secretTask'));
    assert.equal((await write(user, [operation('task', task('secretTask', 'secret', { assignee: first.userId }))])).status, 404);
    assert.equal((await write(user, [operation('savedView', { id: 'bad', project: 'secret', name: 'Bad', type: 'board', filters: [] })])).status, 404);
    assert.equal((await write(user, [operation('project', project('p1', { private: true, members: [member] }))])).status, 403);
  });
  await t.test('simultaneous edits cannot silently overwrite another user; retries are idempotent', async () => {
    const state = await snapshot(),
      existing = state.tasks.find(t => t.id === 't1');
    const writes = await Promise.all([
      write(owner, [operation('task', { ...existing, title: 'Owner change' })], { revision: state.revision }),
      write(user, [operation('task', { ...existing, title: 'Member change' })], { revision: state.revision }),
    ]);
    assert.deepEqual(writes.map(r => r.status).sort(), [200, 409]);
    const latest = await snapshot(),
      mutationId = randomUUID(),
      ops = [operation('task', { ...latest.tasks.find(t => t.id === 't1'), priority: 'high' })];
    const firstWrite = await write(owner, ops, { revision: latest.revision, mutationId });
    assert.equal(firstWrite.status, 200);
    const retry = await write(owner, ops, { revision: latest.revision, mutationId });
    assert.equal(retry.status, 200);
    assert.equal(retry.data.revision, firstWrite.data.revision);
    assert.equal((await write(owner, [], { revision: latest.revision, mutationId })).status, 409);
  });
  await t.test('saved views and personal filter/sort settings persist with account isolation', async () => {
    const view = { id: 'v1', project: 'p1', name: 'Urgent', type: 'table', filters: [{ f: 'priority', op: 'is', v: ['urgent'] }] };
    const preferences = {
      views: { 'p:p1': { filters: view.filters, sort: { f: 'due', dir: 1 }, group: 'assignee', q: 'Task' } },
      projectOrder: ['p1'],
      prefs: { theme: 'dark' },
      collapsed: true,
    };
    const r = await write(owner, [operation('savedView', view)], { preferences });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal((await snapshot(user)).savedViews[0].name, 'Urgent');
    assert.deepEqual((await snapshot()).preferences.views['p:p1'].filters, preferences.views['p:p1'].filters);
    assert.equal((await snapshot()).preferences.prefs.theme, 'dark');
    assert.deepEqual((await snapshot(user)).preferences, {});
    assert.equal((await write(owner, [], { preferences: JSON.parse('{"prefs":{"__proto__":"bad"}}') })).status, 400);
    const shared = await write(owner, [operation('savedView', { ...view, settings: preferences.views['p:p1'] })]);
    assert.equal(shared.status, 200);
    assert.equal((await snapshot(user)).savedViews[0].settings.sort.f, 'due');
  });
  await t.test('dependencies reject missing, hidden and cyclic references and clean deleted targets', async () => {
    const a = (await snapshot()).tasks.find(task => task.id === 't1');
    assert.equal((await write(owner, [operation('task', task('t2'))])).status, 200);
    assert.equal((await write(owner, [operation('task', { ...a, deps: ['t2'] })])).status, 200);
    const b = (await snapshot()).tasks.find(task => task.id === 't2');
    assert.equal((await write(owner, [operation('task', { ...b, deps: ['t1'] })])).status, 400);
    assert.equal((await write(user, [operation('task', { ...a, deps: ['secretTask'] })])).status, 404);
    assert.equal((await write(user, [operation('task', { ...a, deps: ['unknown-task'] })])).status, 400);
    assert.equal((await write(owner, [{ entity: 'task', id: 't2', value: null }])).status, 200);
    assert.deepEqual((await snapshot()).tasks.find(task => task.id === 't1').deps, []);
  });
  await t.test('archive/restore and cascade delete operate on persisted records', async () => {
    let p = (await snapshot()).projects.find(p => p.id === 'p1');
    assert.equal((await write(owner, [operation('project', { ...p, archived: true, archivedAt: Date.now() })])).status, 200);
    assert.equal((await snapshot()).projects.find(p => p.id === 'p1').archived, true);
    p = (await snapshot()).projects.find(p => p.id === 'p1');
    await write(owner, [operation('project', { ...p, archived: false, archivedAt: null })]);
    const current = (await snapshot()).tasks.find(t => t.id === 't1');
    await write(user, [operation('task', { ...current, archived: true })]);
    assert.equal((await snapshot()).tasks.find(t => t.id === 't1').archived, true);
    await write(user, [operation('task', { ...current, archived: false })]);
    assert.equal((await write(user, [{ entity: 'project', id: 'p1', value: null }])).status, 403);
    assert.equal((await write(owner, [{ entity: 'project', id: 'p1', value: null }])).status, 200);
    const after = await snapshot();
    assert.ok(!after.tasks.some(t => t.project === 'p1'));
    assert.ok(!after.savedViews.some(v => v.project === 'p1'));
  });
});
