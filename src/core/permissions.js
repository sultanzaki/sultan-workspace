export const ACCESS_LEVELS = ['viewer', 'commenter', 'editor'];
export function projectPermission(project, user, role) {
  if (!project) return null;
  if (['owner', 'admin'].includes(role)) return 'manager';
  if (role !== 'guest' && project.lead === user) return 'manager';
  const explicit = Object.hasOwn(project.permissions || {}, user) ? project.permissions[user] : null;
  const member = project.members.includes(user) || !!explicit;
  if ((role === 'guest' || project.private) && !member) return null;
  return explicit || (role === 'guest' ? 'viewer' : 'editor');
}
export function projectAllows(project, user, role, action = 'read') {
  const level = projectPermission(project, user, role);
  const rank = { viewer: 1, commenter: 2, editor: 3, manager: 4 };
  return (rank[level] || 0) >= ({ read: 1, comment: 2, write: 3, manage: 4 }[action] || 99);
}
