import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { activity, notify, notifyMany } from './content-access.js';

export const RECURRENCE = ['Daily', 'Weekly', 'Every 2 weeks', 'Monthly'];
const iso = date => date.toISOString().slice(0, 10);
export function shiftDate(value, days) {
  if (!value) return null;
  const date = new Date(value + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return iso(date);
}
export function nextRecurringDate(due, rule, anchor = new Date(due + 'T00:00:00Z').getUTCDate()) {
  const date = new Date(due + 'T00:00:00Z');
  if (rule === 'Monthly') {
    const month = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
    const last = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
    month.setUTCDate(Math.min(anchor, last));
    return iso(month);
  }
  return shiftDate(due, { Daily: 1, Weekly: 7, 'Every 2 weeks': 14 }[rule]);
}
export async function taskChanged(db, { workspace, user, project, before, value, mutation }) {
  if (value.assignee && before?.assignee !== value.assignee)
    await notify(db, {
      workspace,
      recipient: value.assignee,
      actor: user,
      project,
      task: value.id,
      kind: 'assign',
      message: 'assigned you to',
      event: `assignment:${value.id}:${mutation}`,
    });
  if (before && before.status !== value.status)
    await notify(db, {
      workspace,
      recipient: value.assignee,
      actor: user,
      project,
      task: value.id,
      kind: 'update',
      preference: 'push_status',
      message: `changed status to ${value.status} on`,
      event: `status:${value.id}:${mutation}`,
    });
  if (!value.recur || value.archived || value.status !== 'done' || before?.status === 'done') return;
  if ((await db.query('SELECT 1 FROM recurrence_instances WHERE workspace_id=$1 AND source_task_id=$2', [workspace, value.id])).rowCount) return;
  const prior = (await db.query('SELECT anchor_day,next_due::text FROM recurrence_instances WHERE workspace_id=$1 AND next_task_id=$2', [workspace, value.id]))
    .rows[0];
  const anchor = prior && prior.next_due === value.due ? prior.anchor_day : new Date(value.due + 'T00:00:00Z').getUTCDate();
  const due = nextRecurringDate(value.due, value.recur, anchor);
  const keys = (await db.query("SELECT data->>'key' AS key FROM tasks WHERE workspace_id=$1 AND project_id=$2", [workspace, project.id])).rows;
  const seq =
    Math.max(
      project.seq || 200,
      ...keys.map(row => {
        const n = Number(row.key.slice(project.key.length + 1));
        return Number.isSafeInteger(n) ? n : 0;
      }),
    ) + 1;
  const order =
    Number((await db.query("SELECT coalesce(max((data->>'order')::double precision),0) AS n FROM tasks WHERE workspace_id=$1", [workspace])).rows[0].n) + 1;
  const delta = Math.round((new Date(due + 'T00:00:00Z') - new Date(value.due + 'T00:00:00Z')) / 86400000);
  const next = {
    ...value,
    id: randomUUID(),
    key: project.key + '-' + seq,
    status: 'todo',
    due,
    start: shiftDate(value.start, delta),
    created: Date.now(),
    updated: Date.now(),
    completedAt: null,
    archived: false,
    archivedAt: null,
    fav: false,
    order,
    attachments: [],
    subtasks: value.subtasks.map(sub => ({ ...sub, id: randomUUID(), done: false, due: shiftDate(sub.due, delta) })),
  };
  delete next.prevStatus;
  const active = (await db.query('SELECT user_id FROM memberships WHERE workspace_id=$1 AND active', [workspace])).rows.map(r => r.user_id);
  if (!active.includes(next.assignee)) next.assignee = null;
  next.subtasks = next.subtasks.map(sub => ({ ...sub, ...(sub.assignee && !active.includes(sub.assignee) ? { assignee: null } : {}) }));
  await db.query('INSERT INTO tasks(workspace_id,id,project_id,data) VALUES ($1,$2,$3,$4)', [workspace, next.id, project.id, next]);
  await db.query('INSERT INTO recurrence_instances(workspace_id,source_task_id,next_task_id,anchor_day,next_due) VALUES ($1,$2,$3,$4,$5)', [
    workspace,
    value.id,
    next.id,
    anchor,
    due,
  ]);
  project.seq = seq;
  await db.query('UPDATE projects SET data=$1 WHERE workspace_id=$2 AND id=$3', [project, workspace, project.id]);
  await activity(db, workspace, user, project.id, next.id, 'created recurring task');
  await notify(db, {
    workspace,
    recipient: next.assignee,
    project,
    task: next.id,
    kind: 'assign',
    message: 'Recurring task scheduled',
    event: `recurrence:${value.id}`,
  });
}
export async function dueReminders(db, workspace, { now = new Date(), force = false } = {}) {
  const check = await db.query(
    `INSERT INTO automation_runs(workspace_id,checked_at) VALUES ($1,$2)
    ON CONFLICT(workspace_id) DO UPDATE SET checked_at=EXCLUDED.checked_at
    WHERE automation_runs.checked_at < EXCLUDED.checked_at - interval '1 minute' OR $3 RETURNING workspace_id`,
    [workspace, now, force],
  );
  if (!check.rowCount) return 0;
  const today = iso(now),
    tomorrow = shiftDate(today, 1);
  const rows = (
    await db.query(
      `SELECT t.data,p.data AS project FROM tasks t JOIN projects p ON p.workspace_id=t.workspace_id AND p.id=t.project_id
    WHERE t.workspace_id=$1 AND t.data->>'due'<=$2 AND t.data->>'status'<>'done' AND coalesce((t.data->>'archived')::boolean,false)=false
    AND coalesce((p.data->>'archived')::boolean,false)=false
    AND NOT EXISTS(SELECT 1 FROM user_notifications n WHERE n.workspace_id=t.workspace_id AND n.task_id=t.id
      AND n.recipient_id=coalesce((t.data->>'assignee')::uuid,(p.data->>'lead')::uuid)
      AND n.event_key='deadline:'||t.id||':'||(t.data->>'due')||':'||CASE WHEN t.data->>'due'<$3 THEN 'overdue' WHEN t.data->>'due'=$3 THEN 'today' ELSE 'tomorrow' END)`,
      [workspace, tomorrow, today],
    )
  ).rows;
  const notifications = [];
  for (const { data: task, project } of rows) {
    const due = task.due,
      kind = due < today ? 'overdue' : due === today ? 'today' : 'tomorrow';
    notifications.push({
      workspace,
      recipient: task.assignee || project.lead,
      project,
      task: task.id,
      kind: 'update',
      preference: 'push_due',
      message: { overdue: 'melewati deadline', today: 'jatuh tempo hari ini', tomorrow: 'jatuh tempo besok' }[kind],
      snippet: `Deadline: ${due}`,
      event: `deadline:${task.id}:${due}:${kind}`,
    });
  }
  return (await notifyMany(db, notifications)).rowCount;
}
export async function runAutomations(pool) {
  if (!(await pool.query("SELECT to_regclass('app_private.automation_runs') AS name")).rows[0].name) return 0;
  const workspaces = (
    await pool.query(
      "SELECT w.id FROM workspaces w LEFT JOIN automation_runs r ON r.workspace_id=w.id WHERE r.checked_at IS NULL OR r.checked_at<now()-interval '1 minute' ORDER BY r.checked_at NULLS FIRST,w.id LIMIT 25",
    )
  ).rows;
  let count = 0;
  for (const { id } of workspaces)
    count += await transaction(pool, async db => {
      if (!(await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE SKIP LOCKED', [id])).rowCount) return 0;
      return dueReminders(db, id);
    });
  return count;
}
