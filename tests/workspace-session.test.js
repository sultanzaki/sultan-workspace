import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workspaceData, localWorkspaceKey } from '../src/core/workspace-session.js';

const session = {
  user: { id: 'user-1', name: 'Real User', email: 'real@example.test' },
  workspace: {
    id: 'workspace-1',
    name: 'Real Team',
    role: 'member',
    members: [{ id: 'user-1', name: 'Real User', email: 'real@example.test', role: 'member', active: true }],
    teams: [],
  },
  workspaces: [{ id: 'workspace-1', name: 'Real Team', role: 'member' }],
};
test('a native workspace starts without fictional projects, people, teams or invoices', () => {
  const data = workspaceData(session);
  assert.deepEqual(data.projects, []);
  assert.deepEqual(data.tasks, []);
  assert.deepEqual(data.teams, []);
  assert.deepEqual(data.invoices, []);
  assert.equal(data.me, 'user-1');
  assert.equal(data.members.length, 1);
  assert.equal(data.members[0].role, 'Member');
});
test('local project data cannot override authenticated identity, workspace or roles', () => {
  const data = workspaceData(session, {
    projects: [{ id: 'local-project' }],
    me: 'attacker',
    members: [{ id: 'user-1', role: 'Owner' }],
    ws: { id: 'other-workspace' },
    teams: [{ id: 'fake-team' }],
  });
  assert.equal(data.projects[0].id, 'local-project');
  assert.equal(data.me, 'user-1');
  assert.equal(data.ws.id, 'workspace-1');
  assert.equal(data.members[0].role, 'Member');
  assert.deepEqual(data.teams, []);
});
test('local content is scoped separately to each account and workspace', () => {
  assert.notEqual(localWorkspaceKey(session), localWorkspaceKey({ ...session, user: { id: 'user-2' } }));
  assert.notEqual(localWorkspaceKey(session), localWorkspaceKey({ ...session, workspace: { id: 'workspace-2' } }));
  assert.notEqual(localWorkspaceKey(session), 'gr8r.v2');
});
