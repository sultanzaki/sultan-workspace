import assert from 'node:assert/strict';
import { readConfig } from '../server/config.js';

export function testConfig() {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required. Run npm run db:local. Tests never use DATABASE_URL.');
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.ok(
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.pathname.endsWith('_test'),
    'Tests require an explicitly named, disposable local *_test database',
  );
  return readConfig({ NODE_ENV: 'test', DATABASE_URL: url.toString(), APP_ORIGIN: 'http://localhost:5173' });
}
