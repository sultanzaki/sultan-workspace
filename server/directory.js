import { profile } from './accounts.js';
import { canReadProject } from './content-access.js';

export const workspaceDirectorySql = `SELECT w.id,w.name,w.slug,w.settings,
    coalesce((SELECT jsonb_agg(jsonb_build_object('id',u.id,'email',u.email,'name',u.name,'title',u.title,'avatar_color',u.avatar_color,'has_avatar',u.avatar IS NOT NULL,'avatar_updated_at',u.avatar_updated_at,'role',m.role,'active',m.active) ORDER BY m.joined_at,u.id)
      FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=w.id),'[]') members,
    coalesce((SELECT jsonb_agg(t) FROM (SELECT t.id,t.name,coalesce(array_agg(tm.user_id) FILTER(WHERE tm.user_id IS NOT NULL),'{}') members FROM teams t LEFT JOIN team_members tm ON tm.team_id=t.id WHERE t.workspace_id=w.id GROUP BY t.id ORDER BY t.name)t),'[]') teams
    FROM workspaces w WHERE w.id=$1`;

export async function workspaceDirectory(db, ws, user, role, visibleProjects) {
  const row = (await db.query(workspaceDirectorySql, [ws])).rows[0];
  const projects =
    visibleProjects ||
    (role === 'guest'
      ? (await db.query('SELECT data FROM projects WHERE workspace_id=$1', [ws])).rows.map(r => r.data).filter(p => canReadProject(p, user, role))
      : []);
  return formatWorkspaceDirectory(row, user, role, projects);
}

export function formatWorkspaceDirectory(row, user, role, projects) {
  if (role === 'guest') {
    const people = new Set([user, ...projects.flatMap(p => [p.lead, ...p.members, ...Object.keys(p.permissions || {})])]);
    row.members = row.members.filter(m => m.active && (people.has(m.id) || ['owner', 'admin'].includes(m.role)));
    const ids = new Set(row.members.map(m => m.id)),
      teams = new Set(projects.map(p => p.team));
    row.teams = row.teams.filter(t => teams.has(t.id)).map(t => ({ ...t, members: t.members.filter(id => ids.has(id)) }));
  }
  return { ...row, role, members: row.members.map(member => ({ ...profile(member), role: member.role, active: member.active })) };
}
