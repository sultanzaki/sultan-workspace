import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { transaction } from './db.js';
import { email, password, name, hashPassword, parse, fail } from './security.js';

// CLI only: there is deliberately no public first-user registration endpoint.
export async function bootstrap(pool, input) {
  const data = parse(z.object({ email, password, name, workspace: name }), input);
  const hash = await hashPassword(data.password);
  return transaction(pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(84291371)');
    const { rows } = await db.query('SELECT 1 FROM users LIMIT 1');
    if (rows.length) fail(409, 'Bootstrap sudah dijalankan. Gunakan undangan untuk akun berikutnya.');
    const userId = randomUUID(),
      workspaceId = randomUUID();
    await db.query('INSERT INTO users(id,email,name,password_hash,email_verified_at) VALUES ($1,$2,$3,$4,now())', [userId, data.email, data.name, hash]);
    await db.query('INSERT INTO workspaces(id,name) VALUES ($1,$2)', [workspaceId, data.workspace]);
    await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,'owner')", [workspaceId, userId]);
    await db.query("INSERT INTO audit_events(workspace_id,actor_id,action,subject_id) VALUES ($1,$2,'workspace.bootstrap',$1)", [workspaceId, userId]);
    return { userId, workspaceId };
  });
}
