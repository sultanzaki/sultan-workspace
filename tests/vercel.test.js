import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readConfig } from '../server/config.js';
import { createPool, migrate } from '../server/db.js';
import { bootstrap } from '../server/bootstrap.js';
import { createApp } from '../server/app.js';
import { createVercelHandler } from '../server/vercel.js';
import { readApiResponse } from '../src/foundation/http.js';
import { migrationSql } from '../scripts/export-migrations.js';
import { testConfig } from './database.js';
import { initializationDiagnostic } from '../server/diagnostics.js';

test('initialization diagnostics identify safe categories without exposing credentials', () => {
  const sensitive = 'postgresql://user:private-password@private-host/database';
  const timeout = Object.assign(new Error(`Connection timeout: ${sensitive}`), { setupStage: 'database' });
  const result = initializationDiagnostic(timeout);
  assert.equal(result.code, 'DATABASE_TIMEOUT');
  assert.match(result.message, /Session pooler/);
  assert.doesNotMatch(JSON.stringify(result), /private-password|private-host/);
  assert.doesNotMatch(
    JSON.stringify(initializationDiagnostic(Object.assign(new Error(sensitive), { code: sensitive, configFields: [sensitive] }))),
    /private-password|private-host/,
  );
  assert.throws(
    () => readConfig({ DATABASE_URL: sensitive, APP_ORIGIN: 'https://sultan-workspace.vercel.app/' }),
    error => {
      assert.equal(error.code, 'APP_ORIGIN_INVALID');
      assert.deepEqual(error.configFields, ['APP_ORIGIN']);
      return true;
    },
  );
  assert.throws(
    () => readConfig({}),
    error => {
      assert.equal(error.code, 'CONFIG_INVALID');
      assert.deepEqual(error.configFields, ['DATABASE_URL']);
      return true;
    },
  );
});

test('non-JSON platform failures show an actionable message without leaking response bodies', async () => {
  for (const [body, status, contentType] of [
    ['The page could not be found\nNOT_FOUND', 404, 'text/plain'],
    ['<html>private platform diagnostics</html>', 502, 'text/html'],
    ['{"broken":', 200, 'application/json'],
  ]) {
    await assert.rejects(readApiResponse(new Response(body, { status, headers: { 'content-type': contentType } })), error => {
      assert.equal(error.status, 503);
      assert.match(error.message, /Layanan akun belum tersedia/);
      assert.doesNotMatch(error.message, /Unexpected token|private platform|NOT_FOUND/);
      return true;
    });
  }
  await assert.rejects(
    readApiResponse(new Response('{"error":"Silakan login kembali."}', { status: 401, headers: { 'content-type': 'application/json' } })),
    error => error.status === 401,
  );
  assert.equal(await readApiResponse(new Response(null, { status: 204 })), null);
});

test('Vercel uses trusted deployment origins, a small verified database pool and optional mail', () => {
  const config = readConfig({
    VERCEL: '1',
    VERCEL_ENV: 'production',
    VERCEL_PROJECT_PRODUCTION_URL: 'sultan-workspace.vercel.app',
    VERCEL_URL: 'sultan-workspace-deployment.vercel.app',
    DATABASE_URL: 'postgresql://test:placeholder@db.example.test/postgres',
  });
  assert.equal(config.NODE_ENV, 'production');
  assert.equal(config.APP_ORIGIN, 'https://sultan-workspace.vercel.app');
  assert.equal(config.MAIL_TRANSPORT, 'disabled');
  assert.equal(config.database.max, 2);
  assert.equal(config.database.ssl.rejectUnauthorized, true);
  assert.ok(config.allowedOrigins.includes('https://sultan-workspace-deployment.vercel.app'));
  assert.ok(!config.allowedOrigins.includes('https://attacker.vercel.app'));
  assert.ok(!config.allowedOrigins.includes('http://localhost:5173'));
  const custom = readConfig({
    VERCEL: '1',
    VERCEL_URL: 'preview.vercel.app',
    APP_ORIGIN: 'https://workspace.example.test',
    DATABASE_URL: 'postgresql://localhost/db',
  });
  assert.equal(custom.APP_ORIGIN, 'https://workspace.example.test');
});

test('SQL Editor migrations and the Vercel function share the real database contract', async t => {
  const localConfig = testConfig();
  const pool = createPool(localConfig);
  const pools = [],
    deferred = [];
  const createdRoles = [];
  let opens = 0,
    builds = 0,
    registrations = 0;
  const origin = 'https://sultan-workspace.vercel.app';
  const secret = 'test-cron-secret-'.repeat(3);
  const config = readConfig({
    VERCEL: '1',
    VERCEL_ENV: 'production',
    VERCEL_PROJECT_PRODUCTION_URL: 'sultan-workspace.vercel.app',
    DATABASE_URL: localConfig.DATABASE_URL,
    CRON_SECRET: secret,
  });
  await pool.query('DROP SCHEMA IF EXISTS app_private CASCADE');
  // Exercise the revoke branches present on Supabase, absent from plain PostgreSQL.
  for (const role of ['anon', 'authenticated']) {
    const exists = await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (!exists.rowCount) {
      await pool.query(`CREATE ROLE ${role} NOLOGIN`);
      createdRoles.push(role);
    }
  }
  const handler = createVercelHandler({
    loadConfig: () => config,
    openPool: config => {
      opens++;
      const p = createPool(config);
      pools.push(p);
      return p;
    },
    buildApp: async (p, config) => {
      builds++;
      return createApp(p, config);
    },
    registerPool: () => {
      registrations++;
    },
    defer: promise => {
      deferred.push(promise);
    },
  });
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await Promise.all(deferred);
    for (const p of pools) if (!p.ended) await p.end();
    for (const role of createdRoles) await pool.query(`DROP ROLE ${role}`);
    await pool.end();
  });
  async function request(route, { method = 'GET', body, cookie, csrf, headers = {} } = {}) {
    return fetch(base + route, {
      method,
      headers: {
        ...(method !== 'GET' ? { origin, 'content-type': 'application/json' } : {}),
        ...(cookie ? { cookie } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }
  await t.test('missing schema returns JSON 503 instead of a platform parse error', async () => {
    const result = await request('/api/auth/me');
    assert.equal(result.status, 503);
    assert.match(result.headers.get('content-type'), /application\/json/);
    assert.match((await result.json()).error, /migrasi Supabase/);
    assert.equal(opens, 1);
  });
  await t.test('SQL Editor file is repeatable and compatible with subsequent CLI migrations', async () => {
    const sql = await readFile(new URL('../docs/supabase-migration.sql', import.meta.url), 'utf8');
    assert.equal(sql, await migrationSql());
    const results = await pool.query(sql);
    const summary = Array.isArray(results) ? results.at(-1).rows : results.rows;
    assert.equal(summary[0].name, '001_foundation.sql');
    await pool.query(sql);
    await migrate(pool);
    for (const role of ['anon', 'authenticated']) {
      const privileges = await pool.query(
        "SELECT has_schema_privilege($1, 'app_private', 'USAGE') AS usage, has_schema_privilege($1, 'app_private', 'CREATE') AS create",
        [role],
      );
      assert.deepEqual(privileges.rows[0], { usage: false, create: false });
    }
    assert.equal((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count, '1');
    await bootstrap(pool, { email: 'vercel-owner@example.test', name: 'Vercel Owner', workspace: 'Vercel Workspace', password: 'vercel-test-password-123' });
  });
  await t.test('failed initialization recovers after migration and concurrent requests reuse one pool', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => request('/api/health')));
    for (const response of results) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: 'ok' });
    }
    assert.equal(opens, 2);
    assert.equal(builds, 1);
    assert.equal(registrations, 2);
  });
  await t.test('production login works without SMTP and issues a secure cookie', async () => {
    const login = await request('/api/auth/login', { method: 'POST', body: { email: 'vercel-owner@example.test', password: 'vercel-test-password-123' } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /^__Host-sultan_session=/);
    assert.match(cookie, /; Secure;/);
    const me = await request('/api/auth/me', { cookie: cookie.split(';')[0] });
    assert.equal(me.status, 200);
    const identity = await me.json();
    assert.equal(identity.features.email, false);
    assert.equal(identity.workspaces[0].name, 'Vercel Workspace');
    const invitation = await request(`/api/workspaces/${identity.workspaces[0].id}/invitations`, {
      method: 'POST',
      cookie: cookie.split(';')[0],
      csrf: identity.csrfToken,
      body: { email: 'new@example.test' },
    });
    assert.equal(invitation.status, 503);
    assert.match((await invitation.json()).error, /SMTP/);
    const forgot = await request('/api/auth/forgot-password', { method: 'POST', body: { email: 'vercel-owner@example.test' } });
    assert.equal(forgot.status, 503);
    assert.equal((await pool.query('SELECT count(*) FROM mail_outbox')).rows[0].count, '0');
  });
  await t.test('maintenance requires its secret and arbitrary API routes remain JSON 404s', async () => {
    assert.equal((await request('/api/internal/maintenance')).status, 401);
    const cron = await request('/api/internal/maintenance', { headers: { authorization: `Bearer ${secret}` } });
    assert.equal(cron.status, 200);
    assert.deepEqual(await cron.json(), { processed: 0 });
    const unknown = await request('/api/nonexistent');
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'Endpoint tidak ditemukan.');
  });
});
