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
    const ids = data.projects.map(p => p.id);
    data.projOrder = [
      ...(value.content.preferences?.projectOrder || []).filter(id => ids.includes(id)),
      ...ids.filter(id => !(value.content.preferences?.projectOrder || []).includes(id)),
    ];
  }
  const roles = { owner: 'Owner', admin: 'Admin', member: 'Member' };
  data.ws = { id: workspace.id, name: workspace.name, url: workspace.id, c: '#4B5BD6', brand: true };
  data.workspaces = workspaces.map(ws => ({ id: ws.id, name: ws.name, c: '#4B5BD6', plan: '' }));
  data.me = user.id;
  data.members = workspace.members.map(member => ({
    ...member,
    role: roles[member.role],
    title: roles[member.role],
    c: '#4B5BD6',
    status: member.active ? 'active' : 'deactivated',
    team: workspace.teams.find(team => team.members.includes(member.id))?.id || '',
    last: null,
    tz: '',
  }));
  data.teams = workspace.teams.map(team => ({ ...team, icon: 'users', c: '#4B5BD6', desc: '' }));
  return data;
}
