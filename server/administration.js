import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';
import { email, name, role, uuid, token, digest, fail, limit, membership } from './security.js';
import { queueMail } from './mail.js';
import { workspaceDirectory } from './directory.js';
import { contentAccess } from './content-access.js';
import { ACCESS_LEVELS, projectAllows, projectPermission } from '../src/core/permissions.js';

const permission = z.enum(ACCESS_LEVELS);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{2,59}$/)
  .refine(value => !uuid.safeParse(value).success)
  .nullable();
const settings = z
  .object({
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
    brand: z.boolean().optional(),
    membersCanCreateProjects: z.boolean().optional(),
    leadCanInviteGuests: z.boolean().optional(),
  })
  .strict();
const audit = (db, ws, actor, action, subject = null) =>
  db.query('INSERT INTO audit_events(workspace_id,actor_id,action,subject_id) VALUES ($1,$2,$3,$4)', [ws, actor, action, subject]);
export async function bumpRevision(db, ws) {
  await db.query(
    'INSERT INTO content_versions(workspace_id,revision) VALUES ($1,1) ON CONFLICT(workspace_id) DO UPDATE SET revision=content_versions.revision+1',
    [ws],
  );
}
export async function acceptProjectInvitation(db, invite, user, previous) {
  if (!invite.project_id) return;
  const project = (await db.query('SELECT data FROM projects WHERE workspace_id=$1 AND id=$2', [invite.workspace_id, invite.project_id])).rows[0]?.data;
  if (!project) fail(400, 'Proyek undangan sudah tidak tersedia.');
  const rank = { viewer: 1, commenter: 2, editor: 3, manager: 4 },
    level = previous?.active ? projectPermission(project, user.id, previous.role) : null;
  project.members = [...new Set([...project.members, user.id])];
  project.permissions = {
    ...project.permissions,
    [user.id]: rank[level] > rank[invite.project_permission] ? (level === 'manager' ? 'editor' : level) : invite.project_permission,
  };
  await db.query('UPDATE projects SET data=$1 WHERE workspace_id=$2 AND id=$3', [project, invite.workspace_id, project.id]);
  await bumpRevision(db, invite.workspace_id);
}
export function registerAdministration(app, pool, config, { reauthenticate }) {
  const base = '/api/workspaces';
  app.post(base, async (req, res) => {
    await limit(pool, `workspace:${req.session.user_id}`, 10, 3600);
    const input = z.object({ name, slug: slug.optional() }).strict().parse(req.body),
      ws = randomUUID();
    await transaction(pool, async db => {
      await db.query('INSERT INTO workspaces(id,name,slug) VALUES ($1,$2,$3)', [ws, input.name, input.slug || null]);
      await db.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES ($1,$2,'owner')", [ws, req.session.user_id]);
      await audit(db, ws, req.session.user_id, 'workspace.created', ws);
    });
    res.status(201).json({ id: ws, name: input.name, slug: input.slug || null, role: 'owner' });
  });
  app.get(base + '/:ws', async (req, res) => {
    res.json(
      await transaction(pool, async db => {
        await db.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [uuid.parse(req.params.ws)]);
        const role = await membership(db, req.params.ws, req.session.user_id);
        return workspaceDirectory(db, req.params.ws, req.session.user_id, role);
      }),
    );
  });
  app.patch(base + '/:ws', async (req, res) => {
    const input = z
      .object({ name: name.optional(), slug: slug.optional(), settings: settings.optional() })
      .strict()
      .refine(i => Object.keys(i).length > 0)
      .parse(req.body);
    await transaction(pool, async db => {
      await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin'], true);
      if (input.name) await db.query('UPDATE workspaces SET name=$1 WHERE id=$2', [input.name, req.params.ws]);
      if (input.slug !== undefined) await db.query('UPDATE workspaces SET slug=$1 WHERE id=$2', [input.slug, req.params.ws]);
      if (input.settings) await db.query('UPDATE workspaces SET settings=settings||$1::jsonb WHERE id=$2', [JSON.stringify(input.settings), req.params.ws]);
      await bumpRevision(db, req.params.ws);
      await audit(db, req.params.ws, req.session.user_id, 'workspace.updated', req.params.ws);
    });
    res.sendStatus(204);
  });
  app.delete(base + '/:ws', async (req, res) => {
    const input = z
      .object({ name, currentPassword: z.string().min(1).max(128), code: z.string().max(64).optional() })
      .strict()
      .parse(req.body);
    await limit(pool, `workspace-delete:${req.session.user_id}`, 5, 900);
    await transaction(pool, async db => {
      await membership(db, req.params.ws, req.session.user_id, ['owner'], true);
      const workspace = (await db.query('SELECT name FROM workspaces WHERE id=$1', [req.params.ws])).rows[0];
      if (workspace.name !== input.name) fail(400, 'Nama konfirmasi workspace tidak sesuai.');
      await reauthenticate(db, req, input, true);
      await db.query('DELETE FROM workspaces WHERE id=$1', [req.params.ws]);
    });
    res.sendStatus(204);
  });
  app.get(base + '/:ws/invitations', async (req, res) => {
    await membership(pool, req.params.ws, req.session.user_id, ['owner', 'admin']);
    res.json(
      (
        await pool.query(
          'SELECT id,email,role,delivery,project_id,project_permission,expires_at,created_at FROM invitations WHERE workspace_id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC',
          [req.params.ws],
        )
      ).rows,
    );
  });
  app.post(base + '/:ws/invitations', async (req, res) => {
    const input = z
      .object({
        email,
        role: z.enum(['admin', 'member', 'guest']).default('member'),
        delivery: z.enum(['email', 'link']).default('email'),
        project: id.optional(),
        permission: permission.default('viewer'),
      })
      .strict()
      .parse(req.body);
    if (input.delivery === 'email' && config.MAIL_TRANSPORT === 'disabled')
      fail(503, 'Pengiriman email belum diaktifkan. Gunakan undangan lewat link atau atur SMTP.');
    if (input.role === 'guest' && !input.project) fail(400, 'Guest harus diundang ke satu proyek dengan izin yang dipilih.');
    await limit(pool, `invite:${req.session.user_id}`, 30, 3600);
    const invitation = randomUUID(),
      raw = token();
    await transaction(pool, async db => {
      const ownRole = await membership(db, req.params.ws, req.session.user_id, undefined, true);
      if (!['owner', 'admin'].includes(ownRole)) {
        const policy = (await db.query('SELECT settings FROM workspaces WHERE id=$1', [req.params.ws])).rows[0].settings;
        if (ownRole !== 'member' || input.role !== 'guest' || !policy.leadCanInviteGuests)
          fail(403, 'Hanya owner/admin atau lead proyek yang diizinkan dapat mengundang.');
        await contentAccess(db, req.params.ws, req.session.user_id, { project: input.project, lock: false, action: 'manage' });
      }
      if (ownRole !== 'owner' && input.role === 'admin') fail(403, 'Hanya owner yang dapat mengundang admin.');
      if (input.project) await contentAccess(db, req.params.ws, req.session.user_id, { project: input.project, lock: false, action: 'manage' });
      const active = await db.query('SELECT 1 FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND u.email=$2 AND m.active', [
        req.params.ws,
        input.email,
      ]);
      if (active.rowCount) fail(409, 'Pengguna sudah menjadi anggota aktif. Atur akses proyek melalui Share.');
      await db.query('UPDATE invitations SET revoked_at=now() WHERE workspace_id=$1 AND email=$2 AND consumed_at IS NULL AND revoked_at IS NULL', [
        req.params.ws,
        input.email,
      ]);
      await db.query(
        "INSERT INTO invitations(id,workspace_id,email,role,token_hash,invited_by,expires_at,delivery,project_id,project_permission) VALUES ($1,$2,$3,$4,$5,$6,now()+interval '48 hours',$7,$8,$9)",
        [
          invitation,
          req.params.ws,
          input.email,
          input.role,
          digest(raw),
          req.session.user_id,
          input.delivery,
          input.project || null,
          input.project ? input.permission : null,
        ],
      );
      if (input.delivery === 'email')
        await queueMail(db, {
          to: input.email,
          workspaceId: req.params.ws,
          subject: 'Undangan bergabung ke workspace',
          body: `Anda diundang ke workspace. Buka tautan ini dalam 48 jam.\n${config.APP_ORIGIN}/#invite=${raw}`,
          invitationId: invitation,
        });
      await audit(db, req.params.ws, req.session.user_id, 'invitation.created', invitation);
    });
    res.status(201).json({
      id: invitation,
      message: input.delivery === 'link' ? 'Link undangan dibuat. Link ini hanya ditampilkan sekali.' : 'Undangan masuk antrean pengiriman email.',
      ...(input.delivery === 'link' ? { url: `${config.APP_ORIGIN}/#invite=${raw}` } : {}),
    });
  });
  app.delete(base + '/:ws/invitations/:id', async (req, res) => {
    await transaction(pool, async db => {
      const ownRole = await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin'], true);
      const invite = (await db.query('SELECT role FROM invitations WHERE id=$1 AND workspace_id=$2', [uuid.parse(req.params.id), req.params.ws])).rows[0];
      if (!invite) fail(404, 'Undangan tidak ditemukan.');
      if (ownRole !== 'owner' && invite.role === 'admin') fail(403, 'Hanya owner yang dapat mengelola undangan admin.');
      await db.query('UPDATE invitations SET revoked_at=now() WHERE id=$1', [req.params.id]);
      await audit(db, req.params.ws, req.session.user_id, 'invitation.revoked', req.params.id);
    });
    res.sendStatus(204);
  });
  app.patch(base + '/:ws/members/:user', async (req, res) => {
    const input = z
      .object({ role: role.optional(), active: z.boolean().optional() })
      .strict()
      .refine(i => i.role !== undefined || i.active !== undefined)
      .parse(req.body);
    await transaction(pool, async db => {
      const ownRole = await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin'], true);
      const target = (await db.query('SELECT role,active FROM memberships WHERE workspace_id=$1 AND user_id=$2', [req.params.ws, uuid.parse(req.params.user)]))
        .rows[0];
      if (!target) fail(404, 'Anggota tidak ditemukan.');
      if (ownRole !== 'owner' && (!['member', 'guest'].includes(target.role) || (input.role && !['member', 'guest'].includes(input.role))))
        fail(403, 'Hanya owner yang dapat mengelola role owner/admin.');
      const next = { ...target, ...input };
      if (target.role === 'owner' && target.active && (!next.active || next.role !== 'owner')) {
        const count = (
          await db.query("SELECT count(*)::integer n FROM memberships WHERE workspace_id=$1 AND role='owner' AND active AND user_id<>$2", [
            req.params.ws,
            req.params.user,
          ])
        ).rows[0].n;
        if (!count) fail(409, 'Workspace harus memiliki minimal satu owner aktif.');
      }
      await db.query('UPDATE memberships SET role=$1,active=$2 WHERE workspace_id=$3 AND user_id=$4', [next.role, next.active, req.params.ws, req.params.user]);
      if (!next.active) await db.query('DELETE FROM sessions WHERE user_id=$1', [req.params.user]);
      if (!next.active || next.role === 'guest')
        await db.query('DELETE FROM team_members WHERE workspace_id=$1 AND user_id=$2', [req.params.ws, req.params.user]);
      await bumpRevision(db, req.params.ws);
      await audit(db, req.params.ws, req.session.user_id, 'member.updated', req.params.user);
    });
    res.sendStatus(204);
  });
  async function validateTeamMembers(db, ws, members) {
    const rows = (
      await db.query("SELECT user_id FROM memberships WHERE workspace_id=$1 AND active AND role<>'guest' AND user_id=ANY($2::uuid[])", [ws, members])
    ).rows;
    if (rows.length !== members.length) fail(400, 'Tim hanya boleh berisi anggota aktif internal workspace ini.');
  }
  app.post(base + '/:ws/teams', async (req, res) => {
    const input = z
        .object({ name, members: z.array(uuid).max(200).default([]) })
        .strict()
        .parse(req.body),
      team = randomUUID();
    if (new Set(input.members).size !== input.members.length) fail(400, 'Anggota tim tidak boleh ganda.');
    await transaction(pool, async db => {
      await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin'], true);
      await validateTeamMembers(db, req.params.ws, input.members);
      await db.query('INSERT INTO teams(id,workspace_id,name) VALUES ($1,$2,$3)', [team, req.params.ws, input.name]);
      await db.query('INSERT INTO team_members(workspace_id,team_id,user_id) SELECT $1,$2,unnest($3::uuid[])', [req.params.ws, team, input.members]);
      await bumpRevision(db, req.params.ws);
      await audit(db, req.params.ws, req.session.user_id, 'team.created', team);
    });
    res.status(201).json({ id: team, name: input.name });
  });
  app.put(base + '/:ws/teams/:id/members', async (req, res) => {
    const input = z
      .object({
        members: z
          .array(uuid)
          .max(200)
          .refine(a => new Set(a).size === a.length),
      })
      .strict()
      .parse(req.body);
    await transaction(pool, async db => {
      await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin'], true);
      if (!(await db.query('SELECT 1 FROM teams WHERE workspace_id=$1 AND id=$2', [req.params.ws, uuid.parse(req.params.id)])).rowCount)
        fail(404, 'Tim tidak ditemukan.');
      await validateTeamMembers(db, req.params.ws, input.members);
      await db.query('DELETE FROM team_members WHERE team_id=$1', [req.params.id]);
      await db.query('INSERT INTO team_members(workspace_id,team_id,user_id) SELECT $1,$2,unnest($3::uuid[])', [req.params.ws, req.params.id, input.members]);
      await bumpRevision(db, req.params.ws);
      await audit(db, req.params.ws, req.session.user_id, 'team.members.updated', req.params.id);
    });
    res.sendStatus(204);
  });
  app.patch(base + '/:ws/teams/:id', async (req, res) => {
    const input = z
      .object({ name, members: z.array(uuid).max(200).optional() })
      .strict()
      .parse(req.body);
    await transaction(pool, async db => {
      await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin'], true);
      if (
        !(await db.query('UPDATE teams SET name=$1 WHERE workspace_id=$2 AND id=$3 RETURNING id', [input.name, req.params.ws, uuid.parse(req.params.id)]))
          .rowCount
      )
        fail(404, 'Tim tidak ditemukan.');
      if (input.members) {
        if (new Set(input.members).size !== input.members.length) fail(400, 'Anggota tim tidak boleh ganda.');
        await validateTeamMembers(db, req.params.ws, input.members);
        await db.query('DELETE FROM team_members WHERE team_id=$1', [req.params.id]);
        await db.query('INSERT INTO team_members(workspace_id,team_id,user_id) SELECT $1,$2,unnest($3::uuid[])', [req.params.ws, req.params.id, input.members]);
      }
      await bumpRevision(db, req.params.ws);
      await audit(db, req.params.ws, req.session.user_id, 'team.updated', req.params.id);
    });
    res.sendStatus(204);
  });
  app.delete(base + '/:ws/teams/:id', async (req, res) => {
    await transaction(pool, async db => {
      await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin'], true);
      if (!(await db.query('DELETE FROM teams WHERE workspace_id=$1 AND id=$2 RETURNING id', [req.params.ws, uuid.parse(req.params.id)])).rowCount)
        fail(404, 'Tim tidak ditemukan.');
      await db.query("UPDATE projects SET data=jsonb_set(data,'{team}','\"\"'::jsonb) WHERE workspace_id=$1 AND data->>'team'=$2", [
        req.params.ws,
        req.params.id,
      ]);
      await bumpRevision(db, req.params.ws);
      await audit(db, req.params.ws, req.session.user_id, 'team.deleted', req.params.id);
    });
    res.sendStatus(204);
  });
  app.get(base + '/:ws/access-requests', async (req, res) => {
    const ownRole = await membership(pool, req.params.ws, req.session.user_id);
    const rows = (
      await pool.query(
        `SELECT r.*,u.name,u.email,p.data AS project FROM project_access_requests r JOIN users u ON u.id=r.user_id JOIN projects p ON p.workspace_id=r.workspace_id AND p.id=r.project_id WHERE r.workspace_id=$1 ORDER BY r.created_at DESC`,
        [req.params.ws],
      )
    ).rows;
    res.json(
      rows
        .filter(row => row.user_id === req.session.user_id || projectAllows(row.project, req.session.user_id, ownRole, 'manage'))
        .map(row => {
          const { project, ...rest } = row;
          return {
            ...rest,
            projectName: canName(project, row.user_id, req.session.user_id, ownRole) ? project.name : row.project_id,
            canDecide: projectAllows(project, req.session.user_id, ownRole, 'manage'),
          };
        }),
    );
  });
  function canName(project, requester, user, role) {
    return requester !== user || projectAllows(project, user, role, 'read');
  }
  app.post(base + '/:ws/access-requests', async (req, res) => {
    const input = z
      .object({ project: id, permission, reason: z.string().trim().max(1000).default('') })
      .strict()
      .parse(req.body);
    await limit(pool, `request-access:${req.session.user_id}`, 20, 3600);
    const row = await transaction(pool, async db => {
      const role = await membership(db, req.params.ws, req.session.user_id, undefined, true),
        project = (await db.query('SELECT data FROM projects WHERE workspace_id=$1 AND id=$2', [req.params.ws, input.project])).rows[0]?.data;
      if (!project || (role === 'guest' && !projectAllows(project, req.session.user_id, role, 'read')))
        fail(404, 'Proyek tidak ditemukan atau tidak dapat diakses.');
      const ranks = { viewer: 1, commenter: 2, editor: 3, manager: 4 };
      if ((ranks[projectPermission(project, req.session.user_id, role)] || 0) >= ranks[input.permission]) fail(409, 'Anda sudah memiliki tingkat akses ini.');
      return (
        await db.query(
          `INSERT INTO project_access_requests(id,workspace_id,project_id,user_id,permission,reason) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT(workspace_id,project_id,user_id) DO UPDATE SET permission=EXCLUDED.permission,reason=EXCLUDED.reason,status='pending',created_at=now(),decided_by=NULL,decided_at=NULL RETURNING id,status`,
          [randomUUID(), req.params.ws, input.project, req.session.user_id, input.permission, input.reason],
        )
      ).rows[0];
    });
    res.status(201).json(row);
  });
  app.post(base + '/:ws/access-requests/:id/decision', async (req, res) => {
    const input = z.object({ approve: z.boolean(), permission: permission.optional() }).strict().parse(req.body);
    await transaction(pool, async db => {
      await membership(db, req.params.ws, req.session.user_id, undefined, true);
      const request = (
        await db.query('SELECT * FROM project_access_requests WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [req.params.ws, uuid.parse(req.params.id)])
      ).rows[0];
      if (!request) fail(404, 'Permintaan tidak ditemukan.');
      const { project } = await contentAccess(db, req.params.ws, req.session.user_id, { project: request.project_id, action: 'manage', lock: false });
      if (request.status !== 'pending') fail(409, 'Permintaan sudah diproses.');
      if (input.approve) {
        if (!(await db.query('SELECT 1 FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND active', [req.params.ws, request.user_id])).rowCount)
          fail(400, 'Pemohon sudah tidak aktif.');
        project.members = [...new Set([...project.members, request.user_id])];
        project.permissions = { ...project.permissions, [request.user_id]: input.permission || request.permission };
        await db.query('UPDATE projects SET data=$1 WHERE workspace_id=$2 AND id=$3', [project, req.params.ws, project.id]);
        await bumpRevision(db, req.params.ws);
      }
      await db.query('UPDATE project_access_requests SET status=$1,decided_by=$2,decided_at=now() WHERE id=$3', [
        input.approve ? 'approved' : 'rejected',
        req.session.user_id,
        request.id,
      ]);
      await audit(db, req.params.ws, req.session.user_id, 'project.access.decided', request.id);
    });
    res.json({ ok: true });
  });
}
