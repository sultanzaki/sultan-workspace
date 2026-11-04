import { randomUUID } from 'node:crypto';
import { fail, membership } from './security.js';
import { projectAllows } from '../src/core/permissions.js';

export const canReadProject = (project, user, role) => projectAllows(project, user, role, 'read');
export async function contentAccess(db, workspace, user, { project, task, lock = true, action = 'read' } = {}) {
  if (!lock) await db.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [workspace]);
  const role = await membership(db, workspace, user, ['owner', 'admin', 'member', 'guest'], lock);
  let item;
  if (task) {
    item = (await db.query('SELECT data FROM tasks WHERE workspace_id=$1 AND id=$2', [workspace, task])).rows[0]?.data;
    if (!item) fail(404, 'Task tidak ditemukan.');
    if (project && project !== item.project) fail(400, 'Task bukan bagian dari proyek ini.');
    project = item.project;
  }
  const p = (await db.query('SELECT data FROM projects WHERE workspace_id=$1 AND id=$2', [workspace, project])).rows[0]?.data;
  if (!canReadProject(p, user, role)) fail(404, 'Proyek tidak ditemukan atau tidak dapat diakses.');
  if (!projectAllows(p, user, role, action)) fail(403, 'Anda tidak memiliki izin untuk mengubah konten ini.');
  return { role, project: p, task: item };
}
export function activity(db, workspace, actor, project, task, verb) {
  return db.query('INSERT INTO content_activity(id,workspace_id,actor_id,project_id,task_id,verb) VALUES ($1,$2,$3,$4,$5,$6)', [
    randomUUID(),
    workspace,
    actor,
    project,
    task,
    verb,
  ]);
}
export async function notifyMany(db, entries) {
  const candidates = entries.filter(n => n.recipient && n.recipient !== n.actor);
  if (!candidates.length) return { rowCount: 0 };
  const workspace = candidates[0].workspace;
  if (candidates.some(n => n.workspace !== workspace)) throw new Error('Notification batches must belong to one workspace');
  const people = (
    await db.query(
      `SELECT m.user_id,m.role,p.data FROM memberships m LEFT JOIN workspace_preferences p
    ON p.workspace_id=m.workspace_id AND p.user_id=m.user_id WHERE m.workspace_id=$1 AND m.active AND m.user_id=ANY($2::uuid[])`,
      [workspace, [...new Set(candidates.map(n => n.recipient))]],
    )
  ).rows;
  const members = new Map(people.map(person => [person.user_id, person]));
  const rows = [],
    emails = [];
  for (const n of candidates) {
    const person = members.get(n.recipient);
    if (!person || !canReadProject(n.project, n.recipient, person.role)) continue;
    const category = n.preference === 'push_due' ? 'due' : n.preference === 'push_status' ? 'status' : n.kind === 'update' ? 'status' : n.kind;
    emails.push({
      id: randomUUID(),
      workspace_id: workspace,
      recipient_id: n.recipient,
      actor_id: n.actor || null,
      project_id: n.project.id,
      task_id: n.task,
      comment_id: n.comment || null,
      category,
      message: n.message,
      snippet: (n.snippet || '').slice(0, 500),
      event_key: n.event,
    });
    if (person.data?.notifPrefs?.[n.preference || `push_${n.kind}`] === false) continue;
    rows.push({
      id: randomUUID(),
      workspace_id: workspace,
      recipient_id: n.recipient,
      actor_id: n.actor || null,
      project_id: n.project.id,
      task_id: n.task,
      comment_id: n.comment || null,
      kind: n.kind,
      message: n.message,
      snippet: (n.snippet || '').slice(0, 500),
      event_key: n.event,
    });
  }
  if (emails.length)
    await db.query(
      `INSERT INTO email_events(id,workspace_id,recipient_id,actor_id,project_id,task_id,comment_id,category,message,snippet,event_key) SELECT * FROM jsonb_to_recordset($1::jsonb) AS e(id uuid,workspace_id uuid,recipient_id uuid,actor_id uuid,project_id text,task_id text,comment_id uuid,category text,message text,snippet text,event_key text) ON CONFLICT(workspace_id,recipient_id,event_key) DO NOTHING`,
      [JSON.stringify(emails)],
    );
  if (!rows.length) return { rowCount: 0 };
  return db.query(
    `INSERT INTO user_notifications(id,workspace_id,recipient_id,actor_id,project_id,task_id,comment_id,kind,message,snippet,event_key)
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS n(id uuid,workspace_id uuid,recipient_id uuid,actor_id uuid,project_id text,task_id text,comment_id uuid,kind text,message text,snippet text,event_key text)
    ON CONFLICT(workspace_id,recipient_id,event_key) DO NOTHING`,
    [JSON.stringify(rows)],
  );
}
export const notify = (db, entry) => notifyMany(db, [entry]);
