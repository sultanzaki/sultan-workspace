import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

test('the complete API import tree starts without CommonJS require(esm), as on the Vercel runtime', async () => {
  const entry = new URL('../api/index.js', import.meta.url).href;
  const { stdout, stderr } = await run(
    process.execPath,
    [
      '--no-experimental-require-module',
      '--input-type=module',
      '--eval',
      `const api=await import(${JSON.stringify(entry)});if(typeof api.default!=='function')throw new Error('API handler missing');console.log('api-import-ready');`,
    ],
    { timeout: 20000, env: { ...process.env, VERCEL: '1', DATABASE_URL: '' } },
  );
  assert.equal(stdout.trim(), 'api-import-ready');
  assert.doesNotMatch(stderr, /ERR_REQUIRE_ESM|Cannot find module/);
});
