import { readConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { bootstrap } from './bootstrap.js';

const pool = createPool(readConfig());
try {
  if (process.argv[2] === 'migrate') {
    await migrate(pool);
    console.log('Database migrations applied.');
  } else if (process.argv[2] === 'bootstrap') {
    // Sensitive values are read from stdin, never positional arguments or logs.
    let source = '';
    for await (const chunk of process.stdin) source += chunk;
    const input = JSON.parse(source);
    await bootstrap(pool, input);
    console.log('Initial owner and workspace created. Sign in with the supplied credentials.');
  } else {
    throw new Error('Use: cli.js migrate | bootstrap (JSON on stdin)');
  }
} catch (error) {
  console.error(error.status ? error.message : 'Setup failed. Check configuration, database access, and input.');
  process.exitCode = 1;
} finally {
  await pool.end();
}
