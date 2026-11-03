import { spawn } from 'node:child_process';
import { createPool, migrate } from '../server/db.js';
import { testConfig } from '../tests/database.js';

const pool = createPool(testConfig());
try {
  await pool.query('DROP SCHEMA IF EXISTS app_private CASCADE');
  await migrate(pool);
} finally {
  await pool.end();
}
const runner = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...process.argv.slice(2)], { stdio: 'inherit' });
runner.on('exit', code => {
  process.exitCode = code ?? 1;
});
