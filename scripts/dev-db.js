import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';

const container = 'sultan-foundation-postgres';
const dockerArgs = ['--host=unix:///var/run/docker.sock'];
const dockerEnv = { ...process.env };
for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete dockerEnv[key];
function docker(args, options = {}) {
  const result = spawnSync('docker', [...dockerArgs, ...args], { encoding: 'utf8', env: dockerEnv, ...options });
  if (result.status !== 0) throw new Error(`Docker operation failed (${args[0]}). ${result.stderr || ''}`);
  return result.stdout.trim();
}
mkdirSync('.local', { recursive: true, mode: 0o700 });
const secretsPath = '.local/postgres.env';
if (!existsSync(secretsPath)) {
  writeFileSync(secretsPath, `POSTGRES_USER=sultan\nPOSTGRES_DB=sultan\nPOSTGRES_PASSWORD=${randomBytes(24).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
}
if (!existsSync('.env.local')) {
  const password = readFileSync(secretsPath, 'utf8').match(/^POSTGRES_PASSWORD=(.+)$/m)[1];
  writeFileSync(
    '.env.local',
    `DATABASE_URL=postgresql://sultan:${password}@127.0.0.1:55432/sultan\nTEST_DATABASE_URL=postgresql://sultan:${password}@127.0.0.1:55432/sultan_test\nAPP_ORIGIN=http://localhost:5173\nMAIL_TRANSPORT=file\n`,
    { mode: 0o600, flag: 'wx' },
  );
} else {
  console.log('Existing .env.local preserved; no connection settings were overwritten.');
}
const inspect = spawnSync('docker', [...dockerArgs, 'inspect', container, '--format', '{{index .Config.Labels "dev.sultan.foundation"}}'], {
  encoding: 'utf8',
  env: dockerEnv,
});
if (inspect.status === 0) {
  if (inspect.stdout.trim() !== 'true') throw new Error('Container name is already used by an unrelated container.');
  docker(['start', container]);
} else {
  docker([
    'run',
    '-d',
    '--name',
    container,
    '--label',
    'dev.sultan.foundation=true',
    '--env-file',
    secretsPath,
    '-p',
    '127.0.0.1:55432:5432',
    '--mount',
    'type=volume,src=sultan-foundation-postgres,dst=/var/lib/postgresql/data',
    'postgres:17-bookworm',
  ]);
}
let ready = false;
for (let i = 0; i < 30; i++) {
  const check = spawnSync('docker', [...dockerArgs, 'exec', container, 'pg_isready', '-U', 'sultan', '-d', 'sultan'], { env: dockerEnv, stdio: 'ignore' });
  if (check.status === 0) {
    ready = true;
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!ready) throw new Error('PostgreSQL did not become ready. Inspect container logs.');
const testExists = docker(['exec', container, 'psql', '-U', 'sultan', '-d', 'sultan', '-tAc', "SELECT 1 FROM pg_database WHERE datname='sultan_test'"]);
if (testExists !== '1') docker(['exec', container, 'createdb', '-U', 'sultan', 'sultan_test']);
console.log('Local PostgreSQL is ready on port 55432. Connection settings stay in ignored .env.local.');
