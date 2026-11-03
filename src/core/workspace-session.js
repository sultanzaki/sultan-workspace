let session = null;
export const getWorkspaceSession = () => session;
export const setWorkspaceSession = value => {
  session = value;
};
export const localWorkspaceKey = value => `gr8r.local.v1:${value.user.id}:${value.workspace.id}`;

export function workspaceData(value, saved) {
  const { user, workspace, workspaces } = value;
  const data = {
    projects: [],
    tasks: [],
    comments: [],
    activity: [],
    notifs: [],
    files: [],
    events: [],
    projOrder: [],
    savedViews: [],
    recentSearches: [],
    notifPrefs: {},
    sessions: [],
    invoices: [],
    tfa: false,
  };
  // Server content takes precedence over older local drafts. Identity and roles
  // always come from the authenticated API.
  for (const key of ['projects', 'tasks', 'comments', 'activity', 'notifs', 'files', 'events', 'projOrder', 'savedViews', 'recentSearches']) {
    const source = value.content || saved;
    if (Array.isArray(source?.[key])) data[key] = source[key];
  }
  if (value.content) {
    data.notifPrefs = value.content.preferences?.notifPrefs || {};
    data.commentTotals = value.content.commentTotals || {};
    const ids = data.projects.map(p => p.id);
    data.projOrder = [
      ...(value.content.preferences?.projectOrder || []).filter(id => ids.includes(id)),
      ...ids.filter(id => !(value.content.preferences?.projectOrder || []).includes(id)),
    ];
  }
  data.favorites = value.content?.preferences?.favorites || {
    tasks: data.tasks.filter(t => t.fav).map(t => t.id),
    projects: data.projects.filter(p => p.fav).map(p => p.id),
  };
  const directory = value.content?.directory || workspace;
  const roles = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };
  data.ws = {
    id: workspace.id,
    name: directory.name,
    url: directory.slug || workspace.id,
    c: directory.settings?.color || '#4B5BD6',
    brand: directory.settings?.brand !== false,
    settings: directory.settings || {},
  };
  data.workspaces = workspaces.map(ws => ({ id: ws.id, name: ws.name, slug: ws.slug, c: '#4B5BD6', plan: '' }));
  data.me = user.id;
  data.members = directory.members.map(member => ({
    ...member,
    role: roles[member.role],
    title: member.title || roles[member.role],
    c: member.color || '#4B5BD6',
    avatar: member.avatar || null,
    status: member.active ? 'active' : 'deactivated',
    team: directory.teams.find(team => team.members.includes(member.id))?.id || '',
    last: null,
    tz: '',
  }));
  data.teams = directory.teams.map(team => ({ ...team, icon: 'users', c: '#4B5BD6', desc: '' }));
  return data;
}
