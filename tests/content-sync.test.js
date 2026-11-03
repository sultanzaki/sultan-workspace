import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContentSync, contentOperations } from '../src/core/content-sync.js';

const clone = structuredClone;
const initial = () => ({ revision: 0, projects: [], tasks: [], savedViews: [], preferences: {} });
test('diff ignores JSON object ordering while retaining actual field changes and deletions', () => {
  assert.deepEqual(contentOperations({ projects: [{ id: 'p', name: 'A' }] }, { projects: [{ name: 'A', id: 'p' }] }), []);
  assert.deepEqual(contentOperations({ tasks: [{ id: 't' }] }, { tasks: [] }), [{ entity: 'task', id: 't', value: null }]);
});
test('server attachment metadata is excluded from task mutations', () => {
  assert.deepEqual(
    contentOperations({ tasks: [{ id: 't', title: 'Title', attachments: [] }] }, { tasks: [{ id: 't', title: 'Title', attachments: [{ id: 'real-file' }] }] }),
    [],
  );
});
test('edits made during a request are flushed afterwards without being overwritten', async () => {
  let current = { projects: [{ id: 'p', name: 'first' }], tasks: [], savedViews: [], preferences: {} };
  let release, started;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let calls = 0;
  const sync = createContentSync({
    initial: initial(),
    capture: () => current,
    apply: value => {
      current = clone(value);
      delete current.revision;
    },
    status: () => {},
    backup: () => {},
    request: async (method, body) => {
      calls++;
      if (calls === 1) {
        started();
        await gate;
      }
      return {
        revision: body.revision + 1,
        projects: body.operations[0] ? [body.operations[0].value] : [],
        tasks: [],
        savedViews: [],
        preferences: body.preferences,
      };
    },
  });
  const done = sync.flush();
  await ready;
  current.projects[0].name = 'second';
  release();
  await done;
  assert.equal(calls, 2);
  assert.equal(current.projects[0].name, 'second');
  assert.equal(sync.isDirty(), false);
});
test('network retries reuse the mutation ID and retain edits made after the failure', async () => {
  let current = { projects: [{ id: 'p', name: 'first' }], tasks: [], savedViews: [], preferences: {} };
  const bodies = [];
  const sync = createContentSync({
    initial: initial(),
    capture: () => current,
    apply: value => {
      current = { projects: value.projects, tasks: [], savedViews: [], preferences: value.preferences };
    },
    status: () => {},
    backup: () => {},
    request: async (method, body) => {
      bodies.push(clone(body));
      if (bodies.length === 1) throw new TypeError('Failed to fetch');
      return {
        revision: body.revision + 1,
        projects: body.operations[0] ? [body.operations[0].value] : [],
        tasks: [],
        savedViews: [],
        preferences: body.preferences,
      };
    },
  });
  await assert.rejects(sync.flush());
  current.projects[0].name = 'after failure';
  await sync.retry();
  assert.equal(bodies[0].mutationId, bodies[1].mutationId);
  assert.notEqual(bodies[1].mutationId, bodies[2].mutationId);
  assert.equal(current.projects[0].name, 'after failure');
});
test('a newer shared revision arriving during a preference save cannot overwrite concurrent edits', async () => {
  const base = { ...initial(), projects: [{ id: 'p', name: 'original' }] };
  let current = { projects: clone(base.projects), tasks: [], savedViews: [], preferences: { collapsed: true } },
    release,
    started;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  let backup;
  const sync = createContentSync({
    initial: base,
    capture: () => current,
    apply: () => {
      throw new Error('Must not discard edits');
    },
    status: () => {},
    backup: value => {
      backup = clone(value);
    },
    request: async () => {
      started();
      await gate;
      return { ...base, revision: 1, projects: [{ id: 'p', name: 'remote' }] };
    },
  });
  const done = sync.flush();
  await ready;
  current.projects[0].name = 'my unsaved edit';
  release();
  await assert.rejects(done, error => error.status === 409);
  assert.equal(backup.projects[0].name, 'my unsaved edit');
  await assert.rejects(sync.retry(), error => error.status === 409);
});
test('background refresh never discards edits started while the request was in flight', async () => {
  const base = initial();
  let current = { projects: [], tasks: [], savedViews: [], preferences: {} },
    release;
  const response = new Promise(resolve => {
    release = resolve;
  });
  const sync = createContentSync({
    initial: base,
    capture: () => current,
    apply: () => assert.fail('Must preserve new edits'),
    request: () => response,
    status: () => {},
    backup: () => {},
  });
  const refreshing = sync.refresh();
  current.projects.push({ id: 'p', name: 'new edit' });
  release(base);
  await refreshing;
  assert.equal(sync.hasUnsavedContent(), true);
  assert.equal(current.projects[0].name, 'new edit');
});
