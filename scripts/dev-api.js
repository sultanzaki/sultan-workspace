import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

// Node 22 watch mode tries to watch an absent --env-file-if-exists file.
// Load it only when present so CI and environment-only setups can start too.
if (existsSync('.env.local')) loadEnvFile('.env.local');
await import('../server/index.js');
