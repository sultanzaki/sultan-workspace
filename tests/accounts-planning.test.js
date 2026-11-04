import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createPool, migrate, transaction } from '../server/db.js';
import { bootstrap } from '../server/bootstrap.js';
import { hashPassword } from '../server/security.js';
import { createApp } from '../server/app.js';
import { totp, base32, encryptSecret, decryptSecret } from '../server/mfa.js';
import { dueReminders } from '../server/automations.js';
import { eventSlot, moveEvent } from '../src/core/event-time.js';
import { testConfig } from './database.js';

test('authenticator codes match RFC 6238 and encrypted secrets are bound to their account', () => {
  const secret = base32(Buffer.from('12345678901234567890'));
  for (const [seconds, expected] of [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])
    assert.equal(totp(secret, Math.floor(seconds / 30), 8), expected);
  const config = { AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64') },
    encrypted = encryptSecret(secret, config, 'alice');
  assert.notEqual(encrypted, secret);
  assert.equal(decryptSecret(encrypted, config, 'alice'), secret);
  assert.throws(() => decryptSecret(encrypted, config, 'bob'), /encryption key/);
  assert.throws(() => encryptSecret(secret, {}, 'alice'), /AUTH_ENCRYPTION_KEY/);
});

test('accounts, administration and planning use real database state and enforce project permissions', async t => {
  const config = { ...testConfig(), MAIL_TRANSPORT: 'disabled', AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') },
    pool = createPool(config);
  await pool.query('DROP SCHEMA IF EXISTS app_private CASCADE');
  await migrate(pool);
  await migrate(pool);
  const password = 'account-test-password-123',
    first = await bootstrap(pool, { email: 'owner@example.test', name: 'Owner', workspace: 'Workspace', password });
  const member = randomUUID(),
    outsider = randomUUID(),
    otherWs = randomUUID();
  for (const [id, email] of [
    [member, 'member@example.test'],
    [outsider, 'outsider@example.test'],
  ])
    await pool.query('INSERT INTO users(id,email,name,password_hash,email_verified_at) VALUES ($1,$2,$2,$3,now())', [id, email, await hashPassword(password)]);
  await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,'member')", [first.workspaceId, member]);
  await pool.query("INSERT INTO workspaces(id,name) VALUES ($1,'Other')", [otherWs]);
  await pool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,'owner')", [otherWs, outsider]);
  const server = (await createApp(pool, config)).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  });
  const base = `http://127.0.0.1:${server.address().port}/api`,
    ws = `/workspaces/${first.workspaceId}`;
  async function request(path, actor, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(method !== 'GET' ? { origin: config.APP_ORIGIN, 'content-type': 'application/json' } : {}),
        ...(actor ? { cookie: actor.cookie, 'x-csrf-token': actor.csrf } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = response.status === 204 ? null : await response.json();
    return { status: response.status, data, headers: response.headers };
  }
  const expectStatus = (result, status) => {
    assert.equal(result.status, status, JSON.stringify(result.data));
    return result.data;
  };
  async function actorFrom(result) {
    const actor = { cookie: result.headers.get('set-cookie').split(';')[0] };
    actor.csrf = expectStatus(await request('/auth/me', actor), 200).csrfToken;
    return actor;
  }
  async function login(email, passwordValue = password) {
    return actorFrom({ ...(await request('/auth/login', null, 'POST', { email, password: passwordValue })) });
  }
  let owner = await login('owner@example.test'),
    user = await login('member@example.test'),
    stranger = await login('outsider@example.test'),
    guest,
    guestId;
  const snapshot = async (actor = owner) => expectStatus(await request(ws + '/content', actor), 200);
  async function write(actor, operations = [], preferences) {
    const current = await snapshot(actor);
    return request(ws + '/content', actor, 'POST', {
      revision: current.revision,
      mutationId: randomUUID(),
      operations,
      ...(preferences ? { preferences } : {}),
    });
  }
  const op = (entity, value) => ({ entity, id: value.id, value });
  const project = (id, extra = {}) => ({
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
  const task = (id, pid, extra = {}) => ({
    id,
    key: pid.toUpperCase() + '-' + (id === 'task' ? 201 : 202),
    project: pid,
    title: 'Task ' + id,
    status: 'todo',
    assignee: null,
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
  await t.test('profile, avatar and session controls persist without revealing tokens or other accounts', async () => {
    expectStatus(await request('/account/profile', user, 'PATCH', { name: 'Changed Member', title: 'Engineer', color: '#123ABC' }), 200);
    const account = expectStatus(await request('/account', user), 200);
    assert.equal(account.user.name, 'Changed Member');
    assert.equal(account.user.title, 'Engineer');
    expectStatus(await request('/account/avatar', user, 'PUT', { content: Buffer.from('<svg onload="evil()"></svg>').toString('base64') }), 415);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cK2kAAAAASUVORK5CYII=', 'base64');
    expectStatus(await request('/account/avatar', user, 'PUT', { content: png.toString('base64') }), 200);
    const photo = expectStatus(await request('/account', user), 200).user.avatar;
    assert.match(photo, /avatar\?v=/);
    const readPhoto = await fetch(base + photo.replace('/api', ''), { headers: { cookie: owner.cookie } });
    assert.equal(readPhoto.status, 200);
    assert.deepEqual(Buffer.from(await readPhoto.arrayBuffer()), png);
    assert.equal((await fetch(base + photo.replace('/api', ''), { headers: { cookie: stranger.cookie } })).status, 404);
    const second = await login('member@example.test'),
      sessions = expectStatus(await request('/account/sessions', user), 200);
    assert.equal(sessions.length, 2);
    assert.equal(sessions.filter(s => s.current).length, 1);
    assert.ok(!JSON.stringify(sessions).includes('token'));
    const ownerSession = expectStatus(await request('/account/sessions', owner), 200)[0];
    expectStatus(await request('/account/sessions/' + ownerSession.id, user, 'DELETE', {}), 404);
    expectStatus(await request('/account/sessions', user, 'DELETE', {}), 200);
    expectStatus(await request('/auth/me', second), 401);
    expectStatus(await request('/auth/me', owner), 200);
    expectStatus(await request('/account/avatar', user, 'DELETE', {}), 204);
    assert.equal((await snapshot()).directory.members.find(m => m.id === member).avatar, null);
  });
  await t.test('manual invitations work without SMTP, are one-use and restrict guest visibility', async () => {
    expectStatus(
      await write(owner, [
        op('project', project('alpha')),
        op('project', project('secret', { private: true })),
        op('task', task('task', 'alpha')),
        op('task', task('hidden', 'secret')),
      ]),
      200,
    );
    expectStatus(await request(ws + '/invitations', owner, 'POST', { email: 'email@example.test' }), 503);
    const invitation = expectStatus(
      await request(ws + '/invitations', owner, 'POST', {
        email: 'guest@example.test',
        role: 'guest',
        delivery: 'link',
        project: 'alpha',
        permission: 'viewer',
      }),
      201,
    );
    assert.ok(invitation.url);
    const token = invitation.url.split('#invite=')[1];
    assert.ok(token);
    assert.equal((await pool.query('SELECT count(*)::integer n FROM mail_outbox')).rows[0].n, 0);
    const accepted = await request('/auth/invitations/accept', null, 'POST', { token, name: 'Guest', password });
    expectStatus(accepted, 201);
    guest = await actorFrom(accepted);
    guestId = expectStatus(await request('/auth/me', guest), 200).user.id;
    expectStatus(await request('/auth/invitations/accept', null, 'POST', { token, name: 'Guest', password }), 400);
    const content = await snapshot(guest);
    assert.deepEqual(
      content.projects.map(p => p.id),
      ['alpha'],
    );
    assert.deepEqual(
      content.tasks.map(p => p.id),
      ['task'],
    );
    assert.ok(!content.directory.members.some(m => m.id === member));
    expectStatus(await request(ws, stranger), 404);
    expectStatus(await request(ws + '/invitations', guest, 'POST', { email: 'bad@example.test', delivery: 'link' }), 403);
    const list = expectStatus(await request(ws + '/invitations', owner), 200);
    assert.ok(!JSON.stringify(list).includes(token));
  });
  await t.test('viewer/commenter/editor are checked for tasks, comments, files, projects and preferences', async () => {
    const content = await snapshot(guest),
      current = content.tasks[0];
    expectStatus(await write(guest, [op('task', { ...current, title: 'forbidden' })]), 403);
    expectStatus(await request(ws + '/tasks/task/comments', guest, 'POST', { id: randomUUID(), text: 'Denied', mentions: [] }), 403);
    expectStatus(
      await request(ws + '/files', guest, 'POST', {
        id: randomUUID(),
        project: 'alpha',
        task: 'task',
        name: 'test.txt',
        content: Buffer.from('hi').toString('base64'),
      }),
      403,
    );
    expectStatus(await write(guest, [], { favorites: { tasks: ['task'], projects: ['alpha'] }, prefs: { theme: 'dark', tz: 'Asia/Jakarta' } }), 200);
    assert.equal((await snapshot(guest)).tasks[0].fav, true);
    assert.equal((await snapshot()).tasks[0].fav, false);
    let p = (await snapshot()).projects.find(p => p.id === 'alpha');
    expectStatus(
      await write(owner, [op('project', { ...p, permissions: { [guestId]: 'commenter', [member]: 'viewer' }, members: [...p.members, member] })]),
      200,
    );
    expectStatus(await request(ws + '/tasks/task/comments', guest, 'POST', { id: randomUUID(), text: 'Allowed comment', mentions: [] }), 201);
    expectStatus(await write(guest, [op('task', { ...current, title: 'still forbidden' })]), 403);
    expectStatus(await write(user, [op('task', { ...current, title: 'explicitly denied internal user' })]), 403);
    p = (await snapshot()).projects.find(p => p.id === 'alpha');
    expectStatus(await write(owner, [op('project', { ...p, permissions: { ...p.permissions, [guestId]: 'editor' } })]), 200);
    expectStatus(await write(guest, [op('task', { ...current, title: 'Guest edited' })]), 200);
    p = (await snapshot(guest)).projects[0];
    expectStatus(await write(guest, [op('project', { ...p, private: true })]), 403);
    expectStatus(await write(guest, [op('project', project('guestproject'))]), 403);
    expectStatus(await write(owner, [op('task', task('noaccess', 'secret', { assignee: guestId }))]), 400);
  });
  await t.test('access requests are private, approve real grants, and recheck current permissions', async () => {
    const requested = expectStatus(
      await request(ws + '/access-requests', user, 'POST', { project: 'secret', permission: 'commenter', reason: 'Review needed' }),
      201,
    );
    assert.ok(requested.id);
    const own = expectStatus(await request(ws + '/access-requests', user), 200);
    assert.equal(own[0].projectName, 'secret');
    expectStatus(await request(ws + '/access-requests/' + requested.id + '/decision', user, 'POST', { approve: true }), 404);
    expectStatus(await request(ws + '/access-requests/' + requested.id + '/decision', owner, 'POST', { approve: true }), 200);
    assert.ok((await snapshot(user)).projects.some(p => p.id === 'secret'));
    expectStatus(await write(user, [op('task', { ...(await snapshot(user)).tasks.find(t => t.id === 'hidden'), title: 'denied' })]), 403);
    expectStatus(await request(ws + '/access-requests', guest, 'POST', { project: 'secret', permission: 'editor' }), 404);
  });
  await t.test('team/workspace management persists, enforces policies and protects the last owner', async () => {
    const team = expectStatus(await request(ws + '/teams', owner, 'POST', { name: 'Engineering', members: [member] }), 201);
    expectStatus(await request(ws + '/teams/' + team.id, owner, 'PATCH', { name: 'Product', members: [first.userId, member] }), 204);
    let p = (await snapshot()).projects.find(p => p.id === 'alpha');
    expectStatus(await write(owner, [op('project', { ...p, team: team.id })]), 200);
    expectStatus(await request(ws + '/teams/' + team.id, guest, 'PATCH', { name: 'No' }), 403);
    expectStatus(await request(ws + '/teams/' + team.id, owner, 'PATCH', { name: 'Invalid', members: [guestId] }), 400);
    expectStatus(await request(ws + '/teams/' + team.id, owner, 'DELETE', {}), 204);
    assert.equal((await snapshot()).projects.find(p => p.id === 'alpha').team, '');
    expectStatus(
      await request(ws, owner, 'PATCH', {
        name: 'Team renamed',
        slug: 'team-renamed',
        settings: { membersCanCreateProjects: false, leadCanInviteGuests: true, color: '#123456' },
      }),
      204,
    );
    assert.equal((await snapshot()).directory.slug, 'team-renamed');
    expectStatus(await write(user, [op('project', project('blocked'))]), 403);
    expectStatus(await request(ws + '/members/' + first.userId, owner, 'PATCH', { role: 'member' }), 409);
    expectStatus(await request(ws, user, 'DELETE', { name: 'Team renamed', currentPassword: password }), 403);
  });
  await t.test('milestones and events persist with UTC instants, DST validation, guest ACL and personal preferences', async () => {
    let p = (await snapshot()).projects.find(p => p.id === 'alpha');
    expectStatus(await write(owner, [op('project', { ...p, milestones: [{ id: 'launch', name: 'Launch', date: '2037-05-05' }] })]), 200);
    const event = {
      id: 'meeting',
      project: 'alpha',
      title: 'Planning',
      date: '2037-05-04',
      time: '09:00',
      timezone: 'Asia/Jakarta',
      duration: 60,
      allDay: false,
      attendees: [first.userId, guestId],
      description: 'Discuss',
      location: 'Room',
      link: 'https://meet.example.test/',
      type: 'meeting',
    };
    const createdContent = expectStatus(await write(owner, [op('event', event)]), 200);
    assert.ok(createdContent.activity.some(a => a.verb === 'created calendar event'));
    let result = createdContent.events[0];
    assert.equal(result.startsAt, '2037-05-04T02:00:00.000Z');
    assert.equal(result.endsAt, '2037-05-04T03:00:00.000Z');
    assert.deepEqual(eventSlot(result, 'America/Los_Angeles'), { date: '2037-05-03', time: '19:00', label: '19:00' });
    const moved = moveEvent(result, '2037-05-05', 'America/Los_Angeles');
    result = expectStatus(await write(guest, [op('event', { ...moved, title: 'Updated meeting' })]), 200).events[0];
    assert.equal(result.date, '2037-05-06');
    assert.equal(result.time, '09:00');
    expectStatus(await write(user, [op('event', { ...event, title: 'viewer denied' })]), 403);
    expectStatus(await write(owner, [op('event', { ...event, id: 'gap', date: '2037-03-08', time: '02:30', timezone: 'America/New_York' })]), 400);
    expectStatus(await write(owner, [op('event', { ...event, id: 'badurl', link: 'javascript:alert(1)' })]), 400);
    expectStatus(await write(owner, [op('event', { ...event, id: 'private', project: 'secret', attendees: [guestId] })]), 400);
    expectStatus(
      await write(guest, [], {
        prefs: { tz: 'Asia/Jakarta', timeFmt: '24', dateFmt: 'd/M', lang: 'id-ID', weekStart: 0, home: 'mytasks', defaultTab: 'list', showDoneBoard: false },
        collapsed: true,
      }),
      200,
    );
    const prefs = (await snapshot(guest)).preferences;
    assert.equal(prefs.prefs.lang, 'id-ID');
    assert.equal(prefs.collapsed, true);
    assert.equal((await snapshot()).preferences.prefs, undefined);
    const deletedContent = expectStatus(await write(owner, [{ entity: 'event', id: 'meeting', value: null }]), 200);
    assert.ok(deletedContent.activity.some(a => a.verb === 'deleted calendar event'));
    assert.ok(!deletedContent.activity.some(a => a.verb === 'deleted project'));
    assert.equal((await snapshot()).events.length, 0);
  });
  await t.test('deadline labels follow each recipient timezone and stay idempotent', async () => {
    expectStatus(await write(owner, [op('task', task('tzdeadline', 'alpha', { assignee: guestId, due: '2035-06-11' }))]), 200);
    await write(guest, [], { prefs: { tz: 'Asia/Jakarta' } });
    const run = () => transaction(pool, db => dueReminders(db, first.workspaceId, { now: new Date('2035-06-10T18:00:00Z'), force: true }));
    await run();
    await run();
    const rows = (await pool.query("SELECT event_key FROM user_notifications WHERE task_id='tzdeadline' AND actor_id IS NULL")).rows;
    assert.equal(rows.length, 1);
    assert.match(rows[0].event_key, /:today$/);
  });
  await t.test('2FA has encrypted secrets, limited challenges, replay protection and one-use recovery codes', async () => {
    const old = await login('member@example.test');
    expectStatus(await request('/account/mfa/setup', user, 'POST', { currentPassword: 'wrong' }), 401);
    const setup = expectStatus(await request('/account/mfa/setup', user, 'POST', { currentPassword: password }), 200);
    assert.match(setup.otpauth, /otpauth:\/\/totp/);
    const stored = (await pool.query('SELECT pending_secret FROM user_security WHERE user_id=$1', [member])).rows[0].pending_secret;
    assert.ok(!stored.includes(setup.secret));
    let code = totp(setup.secret, Math.floor(Date.now() / 30000));
    const enabled = expectStatus(await request('/account/mfa/confirm', user, 'POST', { code }), 200);
    assert.equal(enabled.recoveryCodes.length, 10);
    expectStatus(await request('/auth/me', old), 401);
    const challenge = await request('/auth/login', null, 'POST', { email: 'member@example.test', password });
    expectStatus(challenge, 202);
    assert.equal(challenge.headers.get('set-cookie'), null);
    expectStatus(await request('/auth/mfa/login', null, 'POST', { challenge: challenge.data.challenge, code }), 401);
    const accepted = await request('/auth/mfa/login', null, 'POST', { challenge: challenge.data.challenge, code: enabled.recoveryCodes[0] });
    expectStatus(accepted, 200);
    const mfaActor = await actorFrom(accepted);
    expectStatus(await request('/auth/mfa/login', null, 'POST', { challenge: challenge.data.challenge, code: enabled.recoveryCodes[1] }), 401);
    const next = expectStatus(await request('/auth/login', null, 'POST', { email: 'member@example.test', password }), 202);
    expectStatus(await request('/auth/mfa/login', null, 'POST', { challenge: next.challenge, code: enabled.recoveryCodes[0] }), 401);
    const codes = expectStatus(
      await request('/account/mfa/recovery', mfaActor, 'POST', { currentPassword: password, code: enabled.recoveryCodes[1] }),
      200,
    ).recoveryCodes;
    expectStatus(await request('/account/mfa/disable', mfaActor, 'POST', { currentPassword: password, code: enabled.recoveryCodes[2] }), 401);
    expectStatus(await request('/account/mfa/disable', mfaActor, 'POST', { currentPassword: password, code: codes[0] }), 200);
    assert.equal(expectStatus(await request('/account', mfaActor), 200).mfa.enabled, false);
    const second = await login('member@example.test');
    expectStatus(await request('/account/password', mfaActor, 'POST', { currentPassword: 'wrong', newPassword: 'new-account-password-123' }), 401);
    expectStatus(await request('/account/password', mfaActor, 'POST', { currentPassword: password, newPassword: 'new-account-password-123' }), 200);
    expectStatus(await request('/auth/me', mfaActor), 401);
    expectStatus(await request('/auth/me', second), 401);
    user = await login('member@example.test', 'new-account-password-123');
    expectStatus(await request('/auth/me', user), 200);
  });
  await t.test('workspace deletion requires owner, matching name and password and cascades only that workspace', async () => {
    const created = expectStatus(await request('/workspaces', owner, 'POST', { name: 'Disposable' }), 201),
      path = '/workspaces/' + created.id;
    expectStatus(await request(path, owner, 'DELETE', { name: 'Wrong', currentPassword: password }), 400);
    expectStatus(await request(path, owner, 'DELETE', { name: 'Disposable', currentPassword: 'wrong' }), 401);
    expectStatus(await request(path, owner, 'DELETE', { name: 'Disposable', currentPassword: password }), 204);
    expectStatus(await request(path, owner), 404);
    expectStatus(await request(ws, owner), 200);
    expectStatus(await request('/workspaces/' + otherWs, stranger), 200);
  });
});
