import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';
import { createPool, migrate } from '../server/db.js';
import { createApp } from '../server/app.js';
import { testConfig } from './database.js';

test('first-owner setup requires the deployment secret and closes atomically after first use', async t => {
  const local = testConfig();
  const pool = createPool(local);
  await pool.query('DROP SCHEMA IF EXISTS app_private CASCADE');
  await migrate(pool);
  const setupToken = 'owner-setup-test-key-not-for-deployment-123';
  const config = readConfig({
    NODE_ENV: 'test',
    DATABASE_URL: local.DATABASE_URL,
    APP_ORIGIN: local.APP_ORIGIN,
    BOOTSTRAP_TOKEN: setupToken,
    TRUST_PROXY_HOPS: '1',
  });
  const servers = [];
  t.after(async () => {
    for (const server of servers) await new Promise(resolve => server.close(resolve));
    await pool.end();
  });
  async function listen(settings) {
    const app = await createApp(pool, settings);
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise(resolve => server.once('listening', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  const disabled = await listen(local),
    enabled = await listen(config);
  const input = { setupToken, name: 'First Owner', email: 'owner@example.test', workspace: 'Real Team', password: 'first-owner-test-password-123' };
  async function post(base, body = input, headers = {}) {
    return fetch(base + '/api/auth/setup', {
      method: 'POST',
      headers: { origin: config.APP_ORIGIN, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  }
  await t.test('absent setup key keeps owner creation disabled', async () => {
    assert.deepEqual(await (await fetch(disabled + '/api/auth/setup')).json(), { available: false });
    assert.equal((await post(disabled)).status, 404);
    assert.deepEqual(await (await fetch(enabled + '/api/auth/setup')).json(), { available: true });
  });
  await t.test('rejects wrong keys, hostile origins, weak passwords and extra role fields', async () => {
    assert.equal((await post(enabled, { ...input, setupToken: 'incorrect-key-'.repeat(4) })).status, 403);
    assert.equal((await post(enabled, input, { origin: 'https://attacker.example.test' })).status, 403);
    assert.equal((await post(enabled, { ...input, password: 'short' })).status, 400);
    assert.equal((await post(enabled, { ...input, role: 'owner' })).status, 400);
    assert.equal((await pool.query('SELECT count(*) FROM users')).rows[0].count, '0');
  });
  await t.test('concurrent submissions create exactly one owner and do not echo secrets', async () => {
    const results = await Promise.all([post(enabled), post(enabled)]);
    assert.deepEqual(results.map(response => response.status).sort(), [201, 409]);
    for (const response of results) {
      const body = await response.text();
      assert.ok(!body.includes(setupToken));
      assert.ok(!body.includes(input.password));
    }
    assert.equal((await pool.query('SELECT count(*) FROM users')).rows[0].count, '1');
    assert.equal((await pool.query("SELECT count(*) FROM memberships WHERE role='owner' AND active")).rows[0].count, '1');
    assert.deepEqual(await (await fetch(enabled + '/api/auth/setup')).json(), { available: false });
    assert.equal((await post(enabled, input, { 'x-forwarded-for': '198.51.100.2' })).status, 409);
    const login = await fetch(enabled + '/api/auth/login', {
      method: 'POST',
      headers: { origin: config.APP_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: input.email, password: input.password }),
    });
    assert.equal(login.status, 200);
  });
  await t.test('failed-key guesses are rate-limited before password hashing', async () => {
    let response;
    for (let i = 0; i < 6; i++) response = await post(enabled, { ...input, setupToken: 'incorrect-key-'.repeat(4) }, { 'x-forwarded-for': '198.51.100.3' });
    assert.equal(response.status, 429);
  });
});
