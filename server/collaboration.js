import { z } from 'zod';
import { transaction } from './db.js';
import { digest, fail, limit, membership } from './security.js';
import { activity, contentAccess, notify, notifyMany, canReadProject } from './content-access.js';

const uuid = z.string().uuid();
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const filename = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(name => ![...name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '/' || char === '\\'));
const commentInput = z.object({ text: z.string().trim().min(1).max(5000), mentions: z.array(uuid).max(50).default([]) });
const emoji = z.enum(['👍', '🎉', '❤️', '👀', '🚀', '✅']);
export const MAX_FILE_BYTES = 3 * 1024 * 1024;
const FILE_COLUMNS = 'id,workspace_id,project_id,task_id,author_id,name,mime,bytes,created_at';
function fileType(name) {
  const ext = name.split('.').at(-1).toLowerCase();
  if (ext === 'fig') return 'fig';
  if (ext === 'pdf') return 'pdf';
  if (['zip', 'rar', '7z'].includes(ext)) return 'zip';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'].includes(ext)) return 'img';
  if (['xlsx', 'xls', 'csv', 'numbers'].includes(ext)) return 'sheet';
  if (['doc', 'docx', 'txt', 'md', 'pages', 'rtf'].includes(ext)) return 'doc';
  if (['js', 'ts', 'json', 'html', 'css', 'py'].includes(ext)) return 'code';
  return 'other';
}
export function fileMetadata(row) {
  return {
    id: row.id,
    project: row.project_id,
    task: row.task_id,
    by: row.author_id,
    name: row.name,
    mime: row.mime,
    bytes: row.bytes,
    size: row.bytes < 1024 ? `${row.bytes} B` : row.bytes < 1048576 ? `${Math.round(row.bytes / 1024)} KB` : `${(row.bytes / 1048576).toFixed(1)} MB`,
    type: fileType(row.name),
    at: +new Date(row.created_at),
    url: `/api/workspaces/${row.workspace_id}/files/${row.id}/download`,
    preview: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(row.mime) ? `/api/workspaces/${row.workspace_id}/files/${row.id}/preview` : null,
  };
}
const commentMetadata = row => ({
  id: row.id,
  task: row.task_id,
  project: row.project_id,
  by: row.author_id,
  text: row.body,
  mentions: row.mentions,
  re: row.reactions,
  at: +new Date(row.created_at),
  editedAt: row.edited_at ? +new Date(row.edited_at) : null,
  version: row.version,
});
function sniff(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  return 'application/octet-stream';
}
async function reserve(db, ws, user, mutation, hash) {
  const old = (await db.query('SELECT digest FROM content_mutations WHERE workspace_id=$1 AND user_id=$2 AND id=$3', [ws, user, mutation])).rows[0];
  if (old) {
    if (old.digest !== hash) fail(409, 'ID permintaan sudah digunakan untuk data lain.');
    return true;
  }
  await db.query('INSERT INTO content_mutations(workspace_id,user_id,id,digest) VALUES ($1,$2,$3,$4)', [ws, user, mutation, hash]);
  return false;
}
async function mentionsFor(db, ws, project, input) {
  const people = (await db.query('SELECT u.id,u.name,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.workspace_id=$1 AND m.active', [ws]))
    .rows;
  const allowed = people.filter(p => canReadProject(project, p.id, p.role));
  if (input.mentions.some(id => !allowed.some(person => person.id === id))) fail(400, 'Mention harus anggota aktif yang dapat mengakses proyek ini.');
  const typed = allowed.filter(person => input.text.includes('@' + person.name) && allowed.filter(p => p.name === person.name).length === 1).map(p => p.id);
  const selected = input.mentions.filter(id => allowed.some(person => person.id === id && input.text.includes('@' + person.name)));
  return [...new Set([...selected, ...typed])].sort();
}
async function commentNotifications(db, ws, user, project, comment, recipients = comment.mentions) {
  const participants = (await db.query('SELECT DISTINCT author_id FROM task_comments WHERE workspace_id=$1 AND task_id=$2', [ws, comment.task_id])).rows.map(
    r => r.author_id,
  );
  const task = (await db.query('SELECT data FROM tasks WHERE workspace_id=$1 AND id=$2', [ws, comment.task_id])).rows[0].data;
  const notifications = [];
  for (const recipient of new Set([...recipients, ...participants, task.assignee, project.lead].filter(Boolean))) {
    const mentioned = recipients.includes(recipient);
    notifications.push({
      workspace: ws,
      recipient,
      actor: user,
      project,
      task: comment.task_id,
      kind: mentioned ? 'mention' : 'comment',
      message: mentioned ? 'mentioned you in' : 'commented on',
      snippet: comment.body,
      event: `comment:${comment.id}:${comment.version}:${mentioned ? 'mention' : 'comment'}`,
      comment: comment.id,
    });
  }
  await notifyMany(db, notifications);
}
export async function collaborationSnapshot(db, ws, user, projects) {
  const row = (
    await db.query(
      `SELECT
    coalesce((SELECT jsonb_agg(c) FROM (SELECT * FROM task_comments WHERE workspace_id=$1 AND project_id=ANY($3::text[]) ORDER BY created_at DESC,id DESC LIMIT 50)c),'[]') AS comments,
    coalesce((SELECT jsonb_agg(f) FROM (SELECT ${FILE_COLUMNS} FROM project_files WHERE workspace_id=$1 AND project_id=ANY($3::text[]))f),'[]') AS files,
    coalesce((SELECT jsonb_object_agg(task_id,n) FROM (SELECT task_id,count(*)::integer n FROM task_comments WHERE workspace_id=$1 AND project_id=ANY($3::text[]) GROUP BY task_id)c),'{}') AS totals,
    coalesce((SELECT jsonb_agg(n) FROM (SELECT * FROM user_notifications WHERE workspace_id=$1 AND recipient_id=$2 AND project_id=ANY($3::text[]) ORDER BY created_at DESC LIMIT 300)n),'[]') AS notifications`,
      [ws, user, projects],
    )
  ).rows[0];
  return {
    comments: row.comments.map(commentMetadata).reverse(),
    files: row.files.map(fileMetadata),
    commentTotals: row.totals,
    notifs: row.notifications.map(n => ({
      id: n.id,
      project: n.project_id,
      task: n.task_id,
      by: n.actor_id,
      type: n.kind,
      text: n.message,
      snippet: n.snippet,
      read: !!n.read_at,
      at: +new Date(n.created_at),
    })),
  };
}
export async function taskResourcesMoved(db, ws, task, project) {
  for (const table of ['task_comments', 'project_files', 'user_notifications'])
    await db.query(`UPDATE ${table} SET project_id=$1 WHERE workspace_id=$2 AND task_id=$3`, [project, ws, task]);
}
async function quota(db, ws, extra) {
  const total = (await db.query('SELECT count(*)::integer n,coalesce(sum(bytes),0)::bigint bytes FROM project_files WHERE workspace_id=$1', [ws])).rows[0];
  if (total.n >= 500 || Number(total.bytes) + extra > 100 * 1024 * 1024)
    fail(413, 'Kuota file workspace penuh (100 MB atau 500 file). Hapus file yang tidak diperlukan.');
}
export function registerCollaboration(app, pool, authenticated) {
  const base = '/api/workspaces/:ws';
  app.get(base + '/tasks/:task/comments', authenticated, async (req, res) => {
    const cursor = req.query.cursor ? uuid.parse(req.query.cursor) : null;
    const result = await transaction(pool, async db => {
      await contentAccess(db, req.params.ws, req.session.user_id, { task: id.parse(req.params.task), lock: false });
      const rows = (
        await db.query(
          `SELECT * FROM task_comments WHERE workspace_id=$1 AND task_id=$2
        AND ($3::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM task_comments WHERE id=$3 AND workspace_id=$1 AND task_id=$2))
        ORDER BY created_at DESC,id DESC LIMIT 51`,
          [req.params.ws, req.params.task, cursor],
        )
      ).rows;
      return { comments: rows.slice(0, 50).map(commentMetadata).reverse(), nextCursor: rows.length > 50 ? rows[49].id : null };
    });
    res.json(result);
  });
  app.post(base + '/tasks/:task/comments', authenticated, async (req, res) => {
    const input = commentInput.extend({ id: uuid }).strict().parse(req.body),
      ws = req.params.ws,
      user = req.session.user_id;
    await limit(pool, `comments:${user}`, 90, 60);
    const comment = await transaction(pool, async db => {
      const { project } = await contentAccess(db, ws, user, { task: id.parse(req.params.task), action: 'comment' });
      const previous = await reserve(db, ws, user, input.id, digest('comment:' + req.params.task + JSON.stringify(input)));
      if (previous) {
        const old = (await db.query('SELECT * FROM task_comments WHERE id=$1 AND workspace_id=$2', [input.id, ws])).rows[0];
        if (!old) fail(410, 'Komentar ini sudah dihapus.');
        return old;
      }
      const mentions = await mentionsFor(db, ws, project, input);
      const row = (
        await db.query('INSERT INTO task_comments(id,workspace_id,project_id,task_id,author_id,body,mentions) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [
          input.id,
          ws,
          project.id,
          req.params.task,
          user,
          input.text,
          mentions,
        ])
      ).rows[0];
      await activity(db, ws, user, project.id, req.params.task, 'commented on');
      await commentNotifications(db, ws, user, project, row);
      return row;
    });
    res.status(201).json(commentMetadata(comment));
  });
  async function accessComment(db, req) {
    const ws = req.params.ws,
      user = req.session.user_id;
    await membership(db, ws, user, ['owner', 'admin', 'member', 'guest'], true);
    const comment = (await db.query('SELECT * FROM task_comments WHERE id=$1 AND workspace_id=$2 FOR UPDATE', [uuid.parse(req.params.comment), ws])).rows[0];
    if (!comment) fail(404, 'Komentar tidak ditemukan.');
    const access = await contentAccess(db, ws, user, { task: comment.task_id, lock: false, action: 'comment' });
    return { comment, ...access };
  }
  app.patch(base + '/comments/:comment', authenticated, async (req, res) => {
    const input = commentInput.extend({ version: z.number().int().positive() }).strict().parse(req.body);
    const result = await transaction(pool, async db => {
      const { comment, project } = await accessComment(db, req);
      if (comment.author_id !== req.session.user_id) fail(403, 'Hanya penulis yang dapat mengedit komentar.');
      const mentions = await mentionsFor(db, req.params.ws, project, input);
      if (comment.version !== input.version) {
        if (comment.body === input.text && JSON.stringify(comment.mentions) === JSON.stringify(mentions)) return comment;
        fail(409, 'Komentar sudah berubah. Muat data terbaru.');
      }
      const row = (
        await db.query('UPDATE task_comments SET body=$1,mentions=$2,edited_at=now(),version=version+1 WHERE id=$3 RETURNING *', [
          input.text,
          mentions,
          comment.id,
        ])
      ).rows[0];
      await activity(db, req.params.ws, req.session.user_id, project.id, comment.task_id, 'edited a comment on');
      for (const recipient of mentions.filter(id => !comment.mentions.includes(id)))
        await notify(db, {
          workspace: req.params.ws,
          recipient,
          actor: req.session.user_id,
          project,
          task: comment.task_id,
          kind: 'mention',
          message: 'mentioned you in',
          snippet: input.text,
          event: `comment-edit:${row.id}:${row.version}`,
          comment: row.id,
        });
      await db.query('UPDATE user_notifications SET snippet=$1 WHERE workspace_id=$2 AND comment_id=$3', [input.text.slice(0, 500), req.params.ws, comment.id]);
      return row;
    });
    res.json(commentMetadata(result));
  });
  app.delete(base + '/comments/:comment', authenticated, async (req, res) => {
    await transaction(pool, async db => {
      const { comment, project, role } = await accessComment(db, req);
      if (comment.author_id !== req.session.user_id && !['owner', 'admin'].includes(role)) fail(403, 'Anda tidak dapat menghapus komentar ini.');
      await db.query('DELETE FROM task_comments WHERE id=$1', [comment.id]);
      await activity(db, req.params.ws, req.session.user_id, project.id, comment.task_id, 'deleted a comment on');
    });
    res.sendStatus(204);
  });
  app.post(base + '/comments/:comment/reactions', authenticated, async (req, res) => {
    const input = z.object({ emoji, present: z.boolean() }).strict().parse(req.body);
    const result = await transaction(pool, async db => {
      const { comment } = await accessComment(db, req),
        people = new Set(comment.reactions[input.emoji] || []);
      if (input.present) people.add(req.session.user_id);
      else people.delete(req.session.user_id);
      comment.reactions[input.emoji] = [...people];
      await db.query('UPDATE task_comments SET reactions=$1 WHERE id=$2', [comment.reactions, comment.id]);
      return comment;
    });
    res.json(commentMetadata(result));
  });
  app.post(base + '/files', authenticated, async (req, res) => {
    if (typeof req.body?.content === 'string' && req.body.content.length > 4194304) fail(413, 'Ukuran file maksimal 3 MB.');
    const input = z
      .object({ id: uuid, project: id, task: id.nullable().default(null), name: filename, content: z.string().min(4).max(4194304) })
      .strict()
      .parse(req.body);
    const bytes = Buffer.from(input.content, 'base64');
    if (bytes.toString('base64') !== input.content) fail(400, 'Isi file tidak valid.');
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) fail(413, 'Ukuran file maksimal 3 MB.');
    await limit(pool, `uploads:${req.session.user_id}`, 30, 60);
    const row = await transaction(pool, async db => {
      const { project } = await contentAccess(db, req.params.ws, req.session.user_id, { project: input.project, task: input.task, action: 'write' });
      const previous = await reserve(db, req.params.ws, req.session.user_id, input.id, digest('file:' + JSON.stringify(input)));
      if (previous) {
        const old = (await db.query(`SELECT ${FILE_COLUMNS} FROM project_files WHERE id=$1 AND workspace_id=$2`, [input.id, req.params.ws])).rows[0];
        if (!old) fail(410, 'File ini sudah dihapus.');
        return old;
      }
      await quota(db, req.params.ws, bytes.length);
      const row = (
        await db.query(
          `INSERT INTO project_files(id,workspace_id,project_id,task_id,author_id,name,mime,bytes,content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${FILE_COLUMNS}`,
          [input.id, req.params.ws, project.id, input.task, req.session.user_id, input.name, sniff(bytes), bytes.length, bytes],
        )
      ).rows[0];
      await activity(db, req.params.ws, req.session.user_id, project.id, input.task, 'uploaded a file to');
      return row;
    });
    res.status(201).json(fileMetadata(row));
  });
  async function accessFile(db, req, bytes = false, lock = true, action = 'write') {
    await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin', 'member', 'guest'], lock);
    const file = (
      await db.query(`SELECT ${FILE_COLUMNS}${bytes ? ',content' : ''} FROM project_files WHERE workspace_id=$1 AND id=$2`, [
        req.params.ws,
        uuid.parse(req.params.file),
      ])
    ).rows[0];
    if (!file) fail(404, 'File tidak ditemukan.');
    const access = await contentAccess(db, req.params.ws, req.session.user_id, { project: file.project_id, task: file.task_id, lock: false, action });
    return { file, ...access };
  }
  for (const action of ['download', 'preview'])
    app.get(base + `/files/:file/${action}`, authenticated, async (req, res) => {
      const { file } = await transaction(pool, db => accessFile(db, req, true, false, 'read'));
      if (action === 'preview' && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.mime))
        fail(415, 'Pratinjau tersedia untuk PNG, JPEG, GIF, dan WebP. Unduh file untuk membukanya.');
      res.set('Content-Type', file.mime);
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Length', String(file.bytes));
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
      res.set(
        'Content-Disposition',
        `${action === 'preview' ? 'inline' : 'attachment'}; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`,
      );
      res.send(file.content);
    });
  app.patch(base + '/files/:file', authenticated, async (req, res) => {
    const { name } = z.object({ name: filename }).strict().parse(req.body);
    const row = await transaction(pool, async db => {
      const { file } = await accessFile(db, req);
      await db.query('UPDATE project_files SET name=$1 WHERE id=$2', [name, file.id]);
      file.name = name;
      await activity(db, req.params.ws, req.session.user_id, file.project_id, file.task_id, 'renamed a file in');
      return file;
    });
    res.json(fileMetadata(row));
  });
  app.post(base + '/files/:file/copy', authenticated, async (req, res) => {
    const { id } = z.object({ id: uuid }).strict().parse(req.body);
    const row = await transaction(pool, async db => {
      const { file } = await accessFile(db, req, true);
      if (await reserve(db, req.params.ws, req.session.user_id, id, digest('copy:' + file.id))) {
        const old = (await db.query(`SELECT ${FILE_COLUMNS} FROM project_files WHERE id=$1 AND workspace_id=$2`, [id, req.params.ws])).rows[0];
        if (!old) fail(410, 'Salinan sudah dihapus.');
        return old;
      }
      await quota(db, req.params.ws, file.bytes);
      const copy = (
        await db.query(
          `INSERT INTO project_files(id,workspace_id,project_id,task_id,author_id,name,mime,bytes,content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${FILE_COLUMNS}`,
          [
            id,
            req.params.ws,
            file.project_id,
            file.task_id,
            req.session.user_id,
            file.name.replace(/(\.[^.]+)?$/, ' copy$1').slice(0, 200),
            file.mime,
            file.bytes,
            file.content,
          ],
        )
      ).rows[0];
      await activity(db, req.params.ws, req.session.user_id, file.project_id, file.task_id, 'copied a file in');
      return copy;
    });
    res.status(201).json(fileMetadata(row));
  });
  app.delete(base + '/files/:file', authenticated, async (req, res) => {
    await transaction(pool, async db => {
      const { file } = await accessFile(db, req);
      await db.query('DELETE FROM project_files WHERE id=$1', [file.id]);
      await activity(db, req.params.ws, req.session.user_id, file.project_id, file.task_id, 'deleted a file from');
    });
    res.sendStatus(204);
  });
  app.post(base + '/notifications/read', authenticated, async (req, res) => {
    const input = z
      .object({ ids: z.array(uuid).max(300).default([]), all: z.boolean().default(false), read: z.boolean() })
      .strict()
      .parse(req.body);
    await transaction(pool, async db => {
      await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin', 'member', 'guest'], true);
      await db.query(
        `UPDATE user_notifications SET read_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE workspace_id=$1 AND recipient_id=$2 AND ($4 OR id=ANY($5::uuid[]))`,
        [req.params.ws, req.session.user_id, input.read, input.all, input.ids],
      );
    });
    res.json({ ok: true });
  });
}
