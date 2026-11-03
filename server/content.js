import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import { transaction } from './db.js';
import { membership, fail, digest, limit } from './security.js';
import { canReadProject } from './content-access.js';
import { collaborationSnapshot, taskResourcesMoved } from './collaboration.js';
import { RECURRENCE, dueReminders, taskChanged } from './automations.js';
import { projectAllows, ACCESS_LEVELS } from '../src/core/permissions.js';
import { workspaceDirectory } from './directory.js';
import { eventSchema, normalizeEvent } from './planning.js';

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success)
    fail(
      400,
      'Data proyek/task tidak valid: ' +
        result.error.issues
          .slice(0, 4)
          .map(issue => issue.path.join('.') || 'payload')
          .join(', '),
    );
  return result.data;
}

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => {
    const d = new Date(value + 'T00:00:00Z');
    return !Number.isNaN(+d) && d.toISOString().slice(0, 10) === value;
  })
  .nullable();
const text = z.string().max(200);
const person = z.string().uuid().nullable();
const priority = z.enum(['none', 'low', 'medium', 'high', 'urgent']);
const status = z.enum(['backlog', 'todo', 'progress', 'review', 'done']);
const number = z.number().finite();
const rich = z
  .string()
  .max(50000)
  .transform(value =>
    sanitizeHtml(value, {
      allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'a', 'blockquote', 'code', 'pre'],
      allowedAttributes: { a: ['href', 'target', 'rel'] },
      allowedSchemes: ['http', 'https', 'mailto'],
    }),
  );
const projectSchema = z.object({
  id,
  key: z.string().regex(/^[A-Z][A-Z0-9-]{0,30}$/),
  name: text.trim().min(1),
  icon: z.string().regex(/^[a-z-]{1,50}$/),
  color: z.string().regex(/^[a-z]{1,20}$/),
  status: z.enum(['planning', 'active', 'risk', 'hold', 'complete']),
  team: z.union([z.literal(''), z.string().uuid()]),
  lead: person,
  due: date,
  start: date,
  fav: z.boolean(),
  members: z.array(z.string().uuid()).max(200),
  permissions: z.record(z.string().uuid(), z.enum(ACCESS_LEVELS)).optional(),
  desc: z.string().max(10000),
  milestones: z
    .array(
      z
        .object({ id, title: text.optional(), name: text.optional(), date: date.refine(value => value !== null), done: z.boolean().optional() })
        .refine(m => (m.name || m.title || '').trim().length > 0),
    )
    .max(100),
  last: number,
  seq: z.number().int().min(0).optional(),
  archived: z.boolean().optional(),
  archivedAt: number.nullable().optional(),
  private: z.boolean().optional(),
  order: number.optional(),
});
const subtaskSchema = z.object({
  id,
  title: text.trim().min(1),
  done: z.boolean(),
  assignee: person.optional(),
  due: date.optional(),
  note: z.string().max(10000).optional(),
});
const taskSchema = z.object({
  id,
  key: z.string().max(50),
  project: id,
  title: text.trim().min(1),
  status,
  assignee: person,
  priority,
  due: date,
  start: date,
  labels: z.array(z.string().regex(/^[a-z0-9_-]{1,40}$/)).max(50),
  subtasks: z.array(subtaskSchema).max(200),
  attachments: z
    .array(z.unknown())
    .max(500)
    .transform(() => []),
  deps: z.array(id).max(100),
  desc: rich,
  estimate: z.union([z.string().max(30), number, z.null()]),
  created: number,
  updated: number,
  order: number,
  fav: z.boolean(),
  recur: z.enum(RECURRENCE).nullable(),
  archived: z.boolean().optional(),
  completedAt: number.nullable().optional(),
  archivedAt: number.nullable().optional(),
  prevStatus: status.optional(),
});
const filters = z
  .array(
    z.object({
      f: z.enum(['status', 'assignee', 'priority', 'due', 'project', 'labels', 'created', 'updated']),
      op: z.enum(['is', 'not']),
      v: z.array(z.string().max(100)).max(200),
    }),
  )
  .max(50);
const viewPreferences = z
  .object({
    filters: filters.default([]),
    sort: z
      .object({
        f: z.enum(['manual', 'title', 'due', 'start', 'priority', 'status', 'assignee', 'created', 'updated', 'estimate', 'project']),
        dir: z.union([z.literal(1), z.literal(-1)]),
      })
      .default({ f: 'manual', dir: 1 }),
    group: z.enum(['status', 'priority', 'assignee', 'project', 'due', 'none']).default('status'),
    q: z.string().max(2000).default(''),
    hidden: z.array(z.string().max(50)).max(50).default([]),
    colW: z.record(z.string().max(50), z.number().finite().min(0).max(10000)).default({}),
    showDone: z.boolean().default(true),
    _projHidden: z.boolean().optional(),
    mode: z.enum(['list', 'board', 'table', 'calendar', 'timeline']).optional(),
  })
  .strict();
const viewSchema = z.object({
  id,
  project: id,
  name: text.trim().min(1),
  type: z.enum(['board', 'list', 'table']),
  filters,
  settings: viewPreferences.optional(),
});
const tables = { project: 'projects', task: 'tasks', savedView: 'saved_views', event: 'calendar_events' };
const schemas = { project: projectSchema, task: taskSchema, savedView: viewSchema, event: eventSchema };
const batch = z
  .object({
    revision: z.number().int().min(0),
    mutationId: z.string().uuid(),
    operations: z.array(z.object({ entity: z.enum(['project', 'task', 'savedView', 'event']), id, value: z.unknown().nullable() }).strict()).max(500),
    preferences: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const canRead = canReadProject;

function safePreferences(value) {
  if (JSON.stringify(value).length > 131072) fail(400, 'Pengaturan tampilan terlalu besar.');
  const walk = item => {
    if (item && typeof item === 'object')
      for (const [key, child] of Object.entries(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(400, 'Pengaturan tidak valid.');
        walk(child);
      }
  };
  walk(value);
  return parse(
    z
      .object({
        prefs: z.record(z.string(), z.union([z.string().max(500), z.boolean(), number, z.null()])).optional(),
        views: z.record(z.string().max(150), viewPreferences).optional(),
        collapsed: z.boolean().optional(),
        projectOrder: z.array(id).max(5000).optional(),
        favorites: z
          .object({ tasks: z.array(id).max(5000), projects: z.array(id).max(5000) })
          .strict()
          .optional(),
        notifPrefs: z
          .object({
            push_mention: z.boolean().optional(),
            push_assign: z.boolean().optional(),
            push_comment: z.boolean().optional(),
            push_due: z.boolean().optional(),
            push_status: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    value,
  );
}
async function snapshot(db, ws, user, role) {
  let projects = (await db.query('SELECT data FROM projects WHERE workspace_id=$1 ORDER BY id', [ws])).rows
    .map(row => row.data)
    .filter(project => canRead(project, user, role));
  const ids = projects.map(project => project.id);
  const row = (
    await db.query(
      `SELECT
    coalesce((SELECT jsonb_agg(data ORDER BY id) FROM tasks WHERE workspace_id=$1 AND project_id=ANY($2::text[])),'[]') AS tasks,
    coalesce((SELECT jsonb_agg(data ORDER BY id) FROM saved_views WHERE workspace_id=$1 AND project_id=ANY($2::text[])),'[]') AS views,
    coalesce((SELECT jsonb_agg(data ORDER BY id) FROM calendar_events WHERE workspace_id=$1 AND project_id=ANY($2::text[])),'[]') AS events,
    coalesce((SELECT revision FROM content_versions WHERE workspace_id=$1),0) AS revision,
    coalesce((SELECT data FROM workspace_preferences WHERE workspace_id=$1 AND user_id=$3),'{}') AS preferences,
    coalesce((SELECT jsonb_agg(to_jsonb(a)) FROM (SELECT * FROM content_activity WHERE workspace_id=$1 AND project_id=ANY($2::text[]) ORDER BY at DESC LIMIT 200) a),'[]') AS activities`,
      [ws, ids, user],
    )
  ).rows[0];
  const collaboration = await collaborationSnapshot(db, ws, user, ids);
  const directory = await workspaceDirectory(db, ws, user, role, projects);
  const favorites = row.preferences.favorites || { projects: projects.filter(p => p.fav).map(p => p.id), tasks: row.tasks.filter(t => t.fav).map(t => t.id) };
  projects = projects.map(p => ({ ...p, fav: favorites.projects.includes(p.id) }));
  return {
    revision: row.revision,
    projects,
    tasks: row.tasks.map(task => ({ ...task, fav: favorites.tasks.includes(task.id), attachments: collaboration.files.filter(file => file.task === task.id) })),
    events: row.events,
    directory,
    savedViews: row.views,
    preferences: row.preferences,
    activity: row.activities.map(a => ({ id: a.id, by: a.actor_id, verb: a.verb, task: a.task_id, project: a.project_id, at: +new Date(a.at), extra: '' })),
    ...collaboration,
  };
}
export function registerContent(app, pool, authenticated) {
  app.get('/api/workspaces/:ws/content', authenticated, async (req, res) => {
    const result = await transaction(pool, async db => {
      parse(z.string().uuid(), req.params.ws);
      await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [req.params.ws]);
      const role = await membership(db, req.params.ws, req.session.user_id);
      await dueReminders(db, req.params.ws);
      return snapshot(db, req.params.ws, req.session.user_id, role);
    });
    res.json(result);
  });
  app.post('/api/workspaces/:ws/content', authenticated, async (req, res) => {
    const input = parse(batch, req.body),
      ws = req.params.ws,
      user = req.session.user_id;
    await limit(pool, `content:${user}`, 300, 60);
    const hash = digest(JSON.stringify(input));
    const result = await transaction(pool, async db => {
      const role = await membership(db, ws, user, ['owner', 'admin', 'member', 'guest'], true);
      const previous = await db.query('SELECT digest FROM content_mutations WHERE workspace_id=$1 AND user_id=$2 AND id=$3', [ws, user, input.mutationId]);
      if (previous.rowCount) {
        if (previous.rows[0].digest !== hash) fail(409, 'ID perubahan sudah dipakai. Muat ulang data.');
        return snapshot(db, ws, user, role);
      }
      await db.query('INSERT INTO content_versions(workspace_id) VALUES ($1) ON CONFLICT DO NOTHING', [ws]);
      const current = await db.query('SELECT revision FROM content_versions WHERE workspace_id=$1', [ws]);
      if (input.operations.length && current.rows[0].revision !== input.revision)
        fail(409, 'Data telah diubah anggota lain. Muat data terbaru sebelum melanjutkan; perubahan Anda belum disimpan.');
      if (new Set(input.operations.map(op => op.entity + ':' + op.id)).size !== input.operations.length) fail(400, 'Perubahan ganda tidak valid.');
      if (input.operations.length) {
        const activeRoles = new Map(
          (await db.query('SELECT user_id,role FROM memberships WHERE workspace_id=$1 AND active', [ws])).rows.map(row => [row.user_id, row.role]),
        );
        const active = [...activeRoles.keys()];
        const teams = (await db.query('SELECT id FROM teams WHERE workspace_id=$1', [ws])).rows.map(row => row.id);
        const projects = new Map((await db.query('SELECT data FROM projects WHERE workspace_id=$1', [ws])).rows.map(row => [row.data.id, row.data]));
        const checkProject = (pid, action = 'read') => {
          const p = projects.get(pid);
          if (!canRead(p, user, role)) fail(404, 'Proyek tidak ditemukan atau tidak dapat diakses.');
          if (!projectAllows(p, user, role, action)) fail(403, 'Anda tidak memiliki izin untuk mengubah konten proyek ini.');
          return p;
        };
        const manager = project => projectAllows(project, user, role, 'manage');
        const ops = [...input.operations].sort((a, b) => {
          const rank = op =>
            op.value === null ? { savedView: 3, event: 3, task: 4, project: 5 }[op.entity] : { project: 0, task: 1, savedView: 2, event: 2 }[op.entity];
          return rank(a) - rank(b);
        });
        for (const op of ops) {
          const table = tables[op.entity];
          const existing = (await db.query(`SELECT data FROM ${table} WHERE workspace_id=$1 AND id=$2`, [ws, op.id])).rows[0]?.data;
          if (op.value === null) {
            if (!existing) continue;
            const project = checkProject(op.entity === 'project' ? op.id : existing.project, 'write');
            if (op.entity === 'project' && !manager(project)) fail(403, 'Hanya pemilik proyek atau admin yang dapat menghapus proyek.');
            await db.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND id=$2`, [ws, op.id]);
            await db.query('INSERT INTO content_activity(id,workspace_id,actor_id,project_id,task_id,verb) VALUES ($1,$2,$3,$4,$5,$6)', [
              randomUUID(),
              ws,
              user,
              project.id,
              op.entity === 'task' ? op.id : null,
              op.entity === 'task' ? 'deleted' : 'deleted project',
            ]);
            if (op.entity === 'project') projects.delete(op.id);
            continue;
          }
          let value = parse(schemas[op.entity], op.value);
          if (value.id !== op.id) fail(400, 'ID perubahan tidak cocok.');
          let project;
          if (op.entity === 'project') {
            value.permissions ??= existing?.permissions || {};
            if (existing) {
              checkProject(op.id, 'write');
              if (Boolean(value.archived) !== Boolean(existing.archived) && !manager(existing))
                fail(403, 'Hanya pemilik proyek atau admin yang dapat mengarsipkan proyek.');
              if (
                !manager(existing) &&
                (value.lead !== existing.lead ||
                  JSON.stringify(value.members) !== JSON.stringify(existing.members) ||
                  [...new Set([...Object.keys(value.permissions), ...Object.keys(existing.permissions || {})])].some(
                    id => value.permissions[id] !== existing.permissions?.[id],
                  ) ||
                  Boolean(value.private) !== Boolean(existing.private))
              )
                fail(403, 'Hanya pemilik proyek atau admin yang dapat mengubah akses proyek.');
            } else {
              const policy = (await db.query('SELECT settings FROM workspaces WHERE id=$1', [ws])).rows[0].settings;
              if (role === 'guest' || (role === 'member' && policy.membersCanCreateProjects === false))
                fail(403, 'Anda tidak diizinkan membuat proyek di workspace ini.');
              value.lead ||= user;
              value.members = [...new Set([...value.members, user, value.lead])];
            }
            if (Object.keys(value.permissions).some(id => !value.members.includes(id))) fail(400, 'Izin proyek hanya boleh diberikan kepada anggota proyek.');
            if (value.lead && activeRoles.get(value.lead) === 'guest') fail(400, 'Lead proyek harus anggota internal.');
            if (new Set(value.milestones.map(m => m.id)).size !== value.milestones.length) fail(400, 'ID milestone harus unik.');
            if (
              value.members.some(id => !active.includes(id) && !existing?.members.includes(id)) ||
              (value.lead && value.lead !== existing?.lead && !active.includes(value.lead)) ||
              (value.team && !teams.includes(value.team))
            )
              fail(400, 'Anggota dan tim proyek harus berasal dari workspace yang sama.');
            if (value.start && value.due && value.start > value.due) fail(400, 'Tanggal mulai harus sebelum deadline.');
            value.last = Date.now();
            await db.query('INSERT INTO projects(workspace_id,id,data) VALUES ($1,$2,$3) ON CONFLICT(workspace_id,id) DO UPDATE SET data=EXCLUDED.data', [
              ws,
              op.id,
              value,
            ]);
            projects.set(op.id, value);
            project = value;
          } else {
            if (existing) checkProject(existing.project, 'write');
            project = checkProject(value.project, 'write');
            if (op.entity === 'task') {
              if (
                (value.assignee && value.assignee !== existing?.assignee && !active.includes(value.assignee)) ||
                value.subtasks.some(s => s.assignee && s.assignee !== existing?.subtasks.find(old => old.id === s.id)?.assignee && !active.includes(s.assignee))
              )
                fail(400, 'Assignee harus anggota aktif workspace.');
              if (new Set(value.subtasks.map(s => s.id)).size !== value.subtasks.length) fail(400, 'ID subtask harus unik.');
              if (value.start && value.due && value.start > value.due) fail(400, 'Tanggal mulai harus sebelum deadline.');
              if (value.recur && !value.due) fail(400, 'Task berulang harus memiliki deadline.');
              if (!value.key.startsWith(project.key + '-')) fail(400, 'Nomor task tidak sesuai proyek.');
              const changedAssignees = [
                ...(value.assignee && value.assignee !== existing?.assignee ? [value.assignee] : []),
                ...value.subtasks.filter(s => s.assignee && s.assignee !== existing?.subtasks.find(old => old.id === s.id)?.assignee).map(s => s.assignee),
              ];
              if (changedAssignees.some(id => !canRead(project, id, activeRoles.get(id)))) fail(400, 'Assignee harus memiliki akses ke proyek.');
              value.created = existing?.created || Date.now();
              value.updated = Date.now();
            }
            if (op.entity === 'event') {
              value = normalizeEvent(value, existing, user);
              if (
                new Set(value.attendees).size !== value.attendees.length ||
                value.attendees.some(id => !active.includes(id) || !canRead(project, id, activeRoles.get(id)))
              )
                fail(400, 'Peserta event harus anggota aktif yang dapat mengakses proyek.');
            }
            await db.query(
              `INSERT INTO ${table}(workspace_id,id,project_id,data) VALUES ($1,$2,$3,$4) ON CONFLICT(workspace_id,id) DO UPDATE SET project_id=EXCLUDED.project_id,data=EXCLUDED.data`,
              [ws, op.id, value.project, value],
            );
          }
          if (op.entity === 'task') {
            if (existing && existing.project !== value.project) await taskResourcesMoved(db, ws, value.id, value.project);
            await taskChanged(db, { workspace: ws, user, project, before: existing, value, mutation: input.mutationId });
          }
          if (op.entity !== 'savedView')
            await db.query('INSERT INTO content_activity(id,workspace_id,actor_id,project_id,task_id,verb) VALUES ($1,$2,$3,$4,$5,$6)', [
              randomUUID(),
              ws,
              user,
              project.id,
              op.entity === 'task' ? op.id : null,
              op.entity === 'project' ? (existing ? 'updated project' : 'created project') : existing ? 'updated' : 'created',
            ]);
        }
        // Validate dependencies after the whole batch, including cross-task deletes.
        const tasks = (await db.query('SELECT id,project_id,data FROM tasks WHERE workspace_id=$1', [ws])).rows;
        const graph = new Map(tasks.map(task => [task.id, task.data.deps]));
        const targets = new Map(tasks.map(task => [task.id, task]));
        const changedIds = new Set(input.operations.filter(op => op.entity === 'task' && op.value !== null).map(op => op.id));
        const deletedIds = new Set(input.operations.filter(op => op.entity === 'task' && op.value === null).map(op => op.id));
        for (const task of tasks) {
          for (const dep of task.data.deps)
            if (changedIds.has(task.id) && !graph.has(dep) && !deletedIds.has(dep)) fail(400, 'Dependency task tidak ditemukan.');
          const cleaned = task.data.deps.filter(dep => graph.has(dep));
          if (cleaned.length !== task.data.deps.length) {
            task.data.deps = cleaned;
            await db.query('UPDATE tasks SET data=$1 WHERE workspace_id=$2 AND id=$3', [task.data, ws, task.id]);
          }
          graph.set(task.id, cleaned);
          if (changedIds.has(task.id))
            for (const dep of cleaned) {
              const target = targets.get(dep);
              checkProject(target.project_id);
            }
        }
        const done = new Set(),
          visiting = new Set();
        const visit = id => {
          if (visiting.has(id)) fail(400, 'Dependency task tidak boleh membentuk siklus.');
          if (done.has(id)) return;
          visiting.add(id);
          for (const next of graph.get(id) || []) visit(next);
          visiting.delete(id);
          done.add(id);
        };
        for (const id of graph.keys()) visit(id);
      }
      if (input.preferences)
        await db.query(
          'INSERT INTO workspace_preferences(workspace_id,user_id,data) VALUES ($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO UPDATE SET data=EXCLUDED.data',
          [ws, user, safePreferences(input.preferences)],
        );
      if (input.operations.length) await db.query('UPDATE content_versions SET revision=revision+1 WHERE workspace_id=$1', [ws]);
      await db.query('INSERT INTO content_mutations(workspace_id,user_id,id,digest) VALUES ($1,$2,$3,$4)', [ws, user, input.mutationId, hash]);
      return snapshot(db, ws, user, role);
    });
    res.json(result);
  });
}
