import { attachDatabasePool, waitUntil } from '@vercel/functions';
import { readConfig } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';
import { initializationDiagnostic } from './diagnostics.js';

export function restoreApiPath(req) {
  const url = new URL(req.url, 'http://internal');
  if (['/api', '/api/', '/api/index'].includes(url.pathname)) {
    const route = url.searchParams.get('__route');
    if (route) {
      if (!route.split('/').every(segment => /^[A-Za-z0-9_-]+$/.test(segment))) return false;
      url.pathname = `/api/${route}`;
    }
  }
  url.searchParams.delete('__route');
  req.url = url.pathname + url.search;
  return true;
}

export function createVercelHandler({
  loadConfig = readConfig,
  openPool = createPool,
  buildApp = createApp,
  registerPool = attachDatabasePool,
  defer = waitUntil,
} = {}) {
  let initialized = null;
  async function initialize() {
    let config;
    try {
      config = loadConfig();
    } catch (error) {
      error.setupStage = 'configuration';
      throw error;
    }
    let pool;
    try {
      pool = openPool(config);
    } catch (error) {
      error.setupStage = 'pool';
      throw error;
    }
    pool.on('error', () => console.error('Database pool connection failed.'));
    let stage = 'pool';
    try {
      registerPool(pool);
      stage = 'database';
      // A deployment must not silently create tables in a production database.
      await pool.query('SELECT name FROM schema_migrations LIMIT 1');
      stage = 'application';
      const app = await buildApp(pool, config);
      return { app };
    } catch (error) {
      error.setupStage = stage;
      await pool.end();
      throw error;
    }
  }
  return async function handler(req, res) {
    if (!restoreApiPath(req)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ error: 'Invalid API address.' }));
      return;
    }
    try {
      initialized ??= initialize().catch(error => {
        initialized = null;
        throw error;
      });
      const { app } = await initialized;
      // Vercel keeps the invocation alive for bounded work after the response.
      // No interval or server listener is created inside the function.
      const finished = new Promise(resolve => {
        res.once('finish', resolve);
        res.once('close', resolve);
      });
      defer(finished.then(() => app.locals.maintain()).catch(() => console.error('Background maintenance failed; will retry.')));
      return app(req, res);
    } catch (error) {
      const diagnostic = initializationDiagnostic(error);
      console.error('API initialization failed:', diagnostic.code, { stage: diagnostic.stage, fields: diagnostic.fields });
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(
        JSON.stringify({
          error: diagnostic.message,
          code: diagnostic.code,
        }),
      );
    }
  };
}
