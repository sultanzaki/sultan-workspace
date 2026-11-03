import { attachDatabasePool, waitUntil } from '@vercel/functions';
import { readConfig } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';

export function createVercelHandler({
  loadConfig = readConfig,
  openPool = createPool,
  buildApp = createApp,
  registerPool = attachDatabasePool,
  defer = waitUntil,
} = {}) {
  let initialized = null;
  async function initialize() {
    const config = loadConfig();
    const pool = openPool(config);
    pool.on('error', () => console.error('Database pool connection failed.'));
    try {
      registerPool(pool);
      // A deployment must not silently create tables in a production database.
      await pool.query('SELECT name FROM schema_migrations LIMIT 1');
      const app = await buildApp(pool, config);
      return { app };
    } catch (error) {
      await pool.end();
      throw error;
    }
  }
  return async function handler(req, res) {
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
      const missingSchema = ['42P01', '3F000'].includes(error.code);
      console.error('API initialization failed:', missingSchema ? 'database migration required' : error.code || error.name);
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(
        JSON.stringify({
          error: missingSchema
            ? 'Database belum disiapkan. Admin perlu menjalankan migrasi Supabase terlebih dahulu.'
            : 'Layanan akun belum siap. Admin perlu memeriksa konfigurasi database dan deployment.',
        }),
      );
    }
  };
}
