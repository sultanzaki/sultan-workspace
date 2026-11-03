import { readConfig } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';

const config = readConfig();
const pool = createPool(config);
pool.on('error', () => console.error('Database pool connection failed.'));
// Startup must fail on missing migrations; deploy migrations explicitly before starting.
await pool.query('SELECT name FROM schema_migrations LIMIT 1');
const app = await createApp(pool, config);
const server = app.listen(config.PORT, '0.0.0.0', () => console.log(`Workspace API listening on port ${config.PORT}`));
let running = false,
  stopping = false;
async function tick() {
  if (running || stopping) return;
  running = true;
  try {
    await app.locals.maintain();
  } catch {
    console.error('Background maintenance failed; will retry.');
  } finally {
    running = false;
  }
}
const timer = setInterval(tick, 5000);
timer.unref();
void tick();
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  server.close(async () => {
    while (running) await new Promise(resolve => setTimeout(resolve, 50));
    await pool.end();
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
