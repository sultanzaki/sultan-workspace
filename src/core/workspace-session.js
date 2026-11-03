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
  // Only local project content/preferences may be restored; identity and roles
  // are always refreshed from the authenticated API, never localStorage.
  for (const key of ['projects', 'tasks', 'comments', 'activity', 'notifs', 'files', 'events', 'projOrder', 'savedViews', 'recentSearches']) {
    if (Array.isArray(saved?.[key])) data[key] = saved[key];
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
