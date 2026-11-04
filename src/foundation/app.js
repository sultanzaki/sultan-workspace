import '../styles/tokens.css';
import '../styles/base.css';
import '../styles/components.css';
import './foundation.css';
import { readApiResponse } from './http.js';
import { setWorkspaceSession } from '../core/workspace-session.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const state = {
  user: null,
  csrfToken: '',
  workspaces: [],
  workspace: null,
  invitations: [],
  audit: [],
  mail: [],
  view: 'login',
  invite: null,
  token: '',
  busy: false,
  features: { email: false },
  setupAvailable: null,
};
const root = document.querySelector('#app');
const managementView = new URLSearchParams(location.search).get('manage') === '1';
document.body.classList.add('foundation-mode');
document.querySelectorAll('link[data-font]').forEach(link => {
  link.media = 'all';
});
const field = (label, key, type = 'text', value = '', extra = '') => {
  const id = `foundation-${key}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return `<div class="field"><label class="label" for="${id}">${label}</label><input class="input input-lg" id="${id}" name="${key}" type="${type}" value="${esc(value)}" required ${extra}></div>`;
};
const submit = label => `<button class="btn btn-primary" type="submit">${label}</button>`;
const roles = (selected, owner = true) =>
  (owner ? ['owner', 'admin', 'member'] : ['member']).map(role => `<option value="${role}" ${role === selected ? 'selected' : ''}>${role}</option>`).join('');
const canManage = () => ['owner', 'admin'].includes(state.workspace?.role);

async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return readApiResponse(response);
}
function message(text, error = false) {
  const box = document.querySelector('#foundation-message');
  box.textContent = text;
  box.className = `foundation-message ${error ? 'bad' : 'ok'}`;
  box.setAttribute('role', error ? 'alert' : 'status');
  if (error) box.focus();
}
async function run(fn) {
  if (state.busy) return;
  state.busy = true;
  const buttons = [...root.querySelectorAll('button')];
  buttons.forEach(button => {
    button.disabled = true;
  });
  root.setAttribute('aria-busy', 'true');
  try {
    await fn();
  } catch (error) {
    if (error.status === 401 && state.user) {
      state.user = null;
      state.csrfToken = '';
      state.workspace = null;
      state.view = state.invite ? 'invite' : 'login';
      render();
    }
    message(error.message === 'Failed to fetch' ? 'Cannot connect. Check your connection and try again.' : error.message, true);
  } finally {
    state.busy = false;
    buttons.forEach(button => {
      button.disabled = false;
    });
    root.removeAttribute('aria-busy');
  }
}
async function loadSession() {
  const session = await api('/auth/me');
  Object.assign(state, session);
}
async function loadWorkspace(id = state.workspace?.id || new URLSearchParams(location.search).get('workspace')) {
  const selected = state.workspaces.find(w => w.id === id || w.slug === id) || state.workspaces[0];
  state.workspace = null;
  state.invitations = [];
  state.audit = [];
  state.mail = [];
  if (!selected) return;
  state.workspace = await api(`/workspaces/${selected.id}`);
  if (!managementView) state.content = await api(`/workspaces/${selected.id}/content`);
  if (canManage() && managementView) {
    [state.invitations, state.audit, state.mail] = await Promise.all(
      ['invitations', 'audit', 'mail-status'].map(part => api(`/workspaces/${selected.id}/${part}`)),
    );
  }
}
async function refresh(id) {
  await loadSession();
  await loadWorkspace(id);
}
function authContent() {
  if (state.view === 'unsubscribe')
    return `<h1>Activity email settings</h1><p>${state.unsubscribeWorkspace ? `Disable activity emails for ${esc(state.unsubscribeWorkspace)}?` : 'Loading email settings…'}</p><p>Account security emails and invitations remain enabled.</p>${state.unsubscribeWorkspace ? `<form data-form="unsubscribe">${submit('Disable activity emails')}</form>` : ''}<button class="btn btn-ghost" data-action="login-view">Go to sign in</button>`;
  if (state.view === 'unsubscribed')
    return '<h1>Activity emails disabled</h1><p>You can enable them again in Settings → Email after signing in.</p><button class="btn" data-action="login-view">Go to sign in</button>';

  if (state.view === 'mfa')
    return `<h1>Two-factor verification</h1><p class="sub">Enter an authenticator code or a recovery code. Each recovery code can only be used once.</p><form data-form="mfa-login">${field('Two-factor or recovery code', 'code', 'text', '', 'autocomplete="one-time-code" maxlength="64"')}${submit('Verify and sign in')}</form><button class="btn btn-ghost" data-action="login-view">Back to sign in</button>`;
  if (state.view === 'setup') {
    if (state.setupAvailable === null)
      return '<h1>Could not load setup</h1><p>The account service is unreachable. Refresh when the service is available again.</p>';
    if (!state.setupAvailable)
      return '<h1>Owner setup unavailable</h1><p>Setup is disabled or the first account already exists. Sign in if you already have an account.</p><button class="btn" data-action="login-view">Go to sign in</button>';
    return `<h1>Create owner account</h1><p class="sub">One-time setup for the workspace owner. Use the setup key stored in Vercel.</p><form data-form="owner-setup">${field('Setup key', 'setupToken', 'password', '', 'autocomplete="off" minlength="32" maxlength="256"')}${field('Full name', 'name', 'text', '', 'autocomplete="name" maxlength="100"')}${field('Owner email', 'email', 'email', '', 'autocomplete="username"')}${field('Workspace name', 'workspace', 'text', '', 'maxlength="100"')}${field('New password', 'password', 'password', '', 'autocomplete="new-password" minlength="12" maxlength="128"')}${field('Confirm password', 'confirmation', 'password', '', 'autocomplete="new-password" minlength="12" maxlength="128"')}${submit('Create owner account')}</form>`;
  }
  if (state.view === 'invite') {
    if (!state.invite)
      return '<h1>Invitation unavailable</h1><p>Ask an administrator to send a new invitation.</p><button class="btn" data-action="login-view">Go to sign in</button>';
    const i = state.invite;
    if (state.user && state.user.email !== i.email)
      return `<h1>Switch account</h1><p>This invitation is for <b>${esc(i.email)}</b>.</p><button class="btn" data-action="logout">Sign out to continue</button>`;
    return `<h1>Join ${esc(i.workspace)}</h1><p class="sub">Invitation for ${esc(i.email)}. This link can only be used once.</p>
      ${i.existingAccount && !state.user ? `<p>You already have an account. Sign in to accept the invitation.</p>${loginForm(i.email)}` : `<form data-form="accept-invite">${!state.user ? field('Full name', 'name', 'text', '', 'autocomplete="name" maxlength="100"') + field('New password', 'password', 'password', '', 'autocomplete="new-password" minlength="12" maxlength="128"') : ''}${submit('Accept invitation')}</form>`}`;
  }
  if (state.view === 'forgot')
    return `<h1>Forgot password?</h1><p class="sub">Enter your account email. If it is registered, we will send a password reset link.</p><form data-form="forgot">${field('Email', 'email', 'email', '', 'autocomplete="email"')}${submit('Send reset instructions')}</form><button class="btn btn-ghost" data-action="login-view">Back to sign in</button>`;
  if (state.view === 'reset')
    return `<h1>New password</h1><p class="sub">Use at least 12 characters. Changing your password revokes all existing sessions.</p><form data-form="reset">${field('New password', 'password', 'password', '', 'autocomplete="new-password" minlength="12" maxlength="128"')}${field('Confirm password', 'confirmation', 'password', '', 'autocomplete="new-password" minlength="12" maxlength="128"')}${submit('Save password')}</form>`;
  return `<h1>Sign in to your workspace</h1><p class="sub">Sign in with your team account. New accounts require an invitation.</p>${loginForm()}<button class="btn btn-ghost" data-action="forgot-view">Forgot password?</button>`;
}
function loginForm(address = '') {
  return `<form data-form="login">${field('Email', 'email', 'email', address, `autocomplete="username" ${address ? 'readonly' : ''}`)}${field('Password', 'password', 'password', '', 'autocomplete="current-password" maxlength="128"')}<label class="row"><input type="checkbox" name="remember"> Remember me for 30 days</label>${submit('Sign in')}</form>`;
}
function workspaceContent() {
  const ws = state.workspace;
  if (!ws) return '<section class="foundation-panel"><h1>No workspace access yet</h1><p>Ask an owner to invite you, or create a new workspace.</p></section>';
  const manager = canManage();
  return `<section class="foundation-panel"><div class="foundation-heading"><div><h1>${esc(ws.name)}</h1><p>Your role: <b>${esc(ws.role)}</b></p></div><button class="btn" data-action="refresh">Refresh</button></div>
    <p class="foundation-note">Manage your workspace, accounts, members, and teams here.</p>
    ${manager ? `<form data-form="rename" class="foundation-inline">${field('Workspace name', 'name', 'text', ws.name, 'maxlength="100"')}${submit('Rename')}</form>` : ''}</section>
    <section class="foundation-panel"><h2>Members</h2><div class="foundation-table"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th>${manager ? '<th>Manage</th>' : ''}</tr></thead><tbody>${ws.members
      .map(member => {
        const editable = manager && (ws.role === 'owner' || member.role === 'member');
        return `<tr><td>${esc(member.name)}${member.id === state.user.id ? ' (you)' : ''}</td><td>${esc(member.email)}</td><td>${esc(member.role)}</td><td>${member.active ? 'Active' : 'Disabled'}</td>${manager ? `<td>${editable ? `<form data-form="member" data-id="${member.id}" class="foundation-inline"><select class="input" name="role" aria-label="Role ${esc(member.name)}">${roles(member.role, ws.role === 'owner')}</select><label class="row"><input type="checkbox" name="active" ${member.active ? 'checked' : ''}>Active</label>${submit('Save')}</form>` : 'Owners only'}</td>` : ''}</tr>`;
      })
      .join('')}</tbody></table></div></section>
    ${manager ? invitationContent() : ''}
    <section class="foundation-panel"><h2>Team</h2>${manager ? `<form data-form="create-team" class="foundation-inline">${field('Team name', 'name', 'text', '', 'maxlength="100"')}${submit('Create team')}</form>` : ''}${
      ws.teams.length
        ? ws.teams
            .map(
              team =>
                `<div class="foundation-team"><h3>${esc(team.name)}</h3>${
                  manager
                    ? `<form data-form="team-members" data-id="${team.id}"><div class="foundation-checks">${ws.members
                        .filter(m => m.active)
                        .map(
                          m =>
                            `<label><input type="checkbox" name="member" value="${m.id}" ${team.members.includes(m.id) ? 'checked' : ''}> ${esc(m.name)}</label>`,
                        )
                        .join('')}</div>${submit('Save team members')}</form>`
                    : `<p>${team.members.map(id => esc(ws.members.find(m => m.id === id)?.name)).join(', ') || 'No members yet.'}</p>`
                }</div>`,
            )
            .join('')
        : '<p>No teams yet.</p>'
    }</section>
    ${manager ? `<section class="foundation-panel"><h2>Administration history</h2><p>The latest 100 events.</p><ul class="foundation-audit">${state.audit.map(event => `<li><time>${esc(new Date(event.created_at).toLocaleString('en-US'))}</time> · ${esc(event.actor)} · ${esc(event.action)}</li>`).join('')}</ul></section>` : ''}`;
}
function invitationContent() {
  return `<section class="foundation-panel"><h2>Invite member</h2>${state.features.email ? `<p>Invitations expire after 48 hours. Sending another invitation invalidates the previous link.</p><form data-form="invite" class="foundation-inline">${field('Recipient email', 'email', 'email')}<div class="field"><label class="label" for="invite-role">Role</label><select class="input" id="invite-role" name="role">${roles('member', false)}${state.workspace.role === 'owner' ? '<option value="admin">admin</option>' : ''}</select></div>${submit('Send invitation')}</form>` : '<p>Email delivery is disabled. Sign-in and workspace management remain available. Configure an email provider to send invitations and account recovery emails.</p>'}
    <h3>Active invitations</h3>${state.invitations.length ? `<ul>${state.invitations.map(i => `<li>${esc(i.email)} · ${esc(i.role)} · kedaluwarsa ${esc(new Date(i.expires_at).toLocaleString('en-US'))} ${state.workspace.role === 'owner' || i.role === 'member' ? `<button class="btn btn-ghost" data-action="revoke" data-id="${i.id}">Revoke invitation</button>` : ''}</li>`).join('')}</ul>` : '<p>No active invitations.</p>'}
    <details><summary>Invitation email delivery status</summary><ul>${state.mail.map(mail => `<li>${esc(mail.recipient)} · ${mail.sent_at ? 'Sent to email provider' : mail.attempts ? 'Delivery failed; retry scheduled' : 'Awaiting delivery'}</li>`).join('') || '<li>No deliveries yet.</li>'}</ul></details></section>`;
}
function render() {
  if (state.user && state.workspace && state.view === 'workspace' && !managementView) {
    root.innerHTML = '<main class="foundation-main" role="status">Opening workspace…</main>';
    setWorkspaceSession({
      user: state.user,
      workspace: state.workspace,
      workspaces: state.workspaces,
      csrfToken: state.csrfToken,
      content: state.content,
      features: state.features,
    });
    document.body.classList.remove('foundation-mode');
    void import('../native-workspace.js').catch(() => {
      root.innerHTML =
        '<main class="foundation-main"><p role="alert">Could not load the workspace. Refresh the page.</p><a href="/?manage=1">Manage account and workspace</a></main>';
    });
    return;
  }
  document.documentElement.lang = 'en';
  document.title = state.user && state.view === 'workspace' ? `${state.workspace?.name || 'Workspace'} · Gr8r Studio` : 'Team account · Gr8r Studio';
  root.innerHTML = `<div class="foundation"><header class="foundation-header"><strong>Gr8r Studio</strong>${state.user ? `<div class="row">${state.workspace ? `<a class="btn" href="/?workspace=${state.workspace.id}">Open workspace</a>` : ''}<span>${esc(state.user.name)}</span><button class="btn btn-ghost" data-action="logout">Sign out</button></div>` : '<span>Team account</span>'}</header><main class="foundation-main ${state.view !== 'workspace' ? 'foundation-auth' : ''}"><div id="foundation-message" tabindex="-1" aria-live="polite"></div>${state.view === 'workspace' && state.user ? `<div class="foundation-switch"><label for="workspace-select">Workspace</label><select class="input" id="workspace-select">${state.workspaces.map(w => `<option value="${w.id}" ${w.id === state.workspace?.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select></div>${workspaceContent()}<details class="foundation-panel"><summary>Create new workspace</summary><form data-form="create-workspace" class="foundation-inline">${field('New workspace name', 'name', 'text', '', 'maxlength="100"')}${submit('Create workspace')}</form></details>` : `<section class="foundation-panel">${authContent()}</section>`}</main></div>`;
}

root.addEventListener('submit', event => {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  const values = new FormData(form),
    data = Object.fromEntries(values);
  void run(async () => {
    const base = `/workspaces/${state.workspace?.id}`;
    let notice = 'Changes saved.';
    switch (form.dataset.form) {
      case 'unsubscribe':
        await api('/email/unsubscribe', 'POST', { token: state.token });
        state.token = '';
        state.view = 'unsubscribed';
        render();
        return;
      case 'owner-setup':
        if (data.password !== data.confirmation) throw new Error('Password confirmation does not match.');
        await api('/auth/setup', 'POST', {
          setupToken: data.setupToken,
          email: data.email,
          name: data.name,
          workspace: data.workspace,
          password: data.password,
        });
        form.reset();
        state.setupAvailable = false;
        state.view = 'login';
        history.replaceState(null, '', location.pathname + location.search);
        render();
        message('Owner account created. Sign in, then remove BOOTSTRAP_TOKEN from Vercel.');
        return;
      case 'login': {
        const result = await api('/auth/login', 'POST', { email: data.email, password: data.password, remember: values.has('remember') });
        form.reset();
        if (result.requiresMfa) {
          state.challenge = result.challenge;
          state.view = 'mfa';
          render();
          return;
        }
        await refresh();
        state.view = state.invite ? 'invite' : 'workspace';
        render();
        return;
      }
      case 'mfa-login':
        await api('/auth/mfa/login', 'POST', { challenge: state.challenge, code: data.code });
        state.challenge = null;
        form.reset();
        await refresh();
        state.view = state.invite ? 'invite' : 'workspace';
        render();
        return;
      case 'accept-invite':
        await api('/auth/invitations/accept', 'POST', { token: state.token, ...(!state.user ? { name: data.name, password: data.password } : {}) });
        state.token = '';
        state.invite = null;
        await refresh();
        state.view = 'workspace';
        render();
        message('Invitation accepted. Welcome aboard.');
        return;
      case 'forgot':
        await api('/auth/forgot-password', 'POST', { email: data.email });
        render();
        message('If the account exists, password reset instructions will be sent.');
        return;
      case 'reset':
        if (data.password !== data.confirmation) throw new Error('Password confirmation does not match.');
        await api('/auth/reset-password', 'POST', { token: state.token, password: data.password });
        state.user = null;
        state.csrfToken = '';
        state.token = '';
        state.view = 'login';
        render();
        message('Password updated. Please sign in again.');
        return;
      case 'create-workspace': {
        const ws = await api('/workspaces', 'POST', { name: data.name });
        await refresh(ws.id);
        render();
        message('Workspace dibuat.');
        return;
      }
      case 'rename':
        await api(base, 'PATCH', { name: data.name });
        break;
      case 'invite':
        await api(`${base}/invitations`, 'POST', { email: data.email, role: data.role });
        notice = 'Invitation queued. Check delivery status if the email does not arrive.';
        break;
      case 'member':
        await api(`${base}/members/${form.dataset.id}`, 'PATCH', { role: data.role, active: values.has('active') });
        break;
      case 'create-team':
        await api(`${base}/teams`, 'POST', { name: data.name });
        break;
      case 'team-members':
        await api(`${base}/teams/${form.dataset.id}/members`, 'PUT', { members: values.getAll('member') });
        break;
      default:
        return;
    }
    await refresh();
    render();
    message(notice);
  });
});
root.addEventListener('click', event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  void run(async () => {
    switch (button.dataset.action) {
      case 'forgot-view':
        state.view = 'forgot';
        render();
        break;
      case 'login-view':
        state.view = 'login';
        if (location.hash === '#setup') history.replaceState(null, '', location.pathname + location.search);
        render();
        break;
      case 'refresh':
        await refresh();
        render();
        message('Data refreshed.');
        break;
      case 'logout':
        await api('/auth/logout', 'POST', {});
        state.user = null;
        state.csrfToken = '';
        state.workspace = null;
        state.view = state.invite ? 'invite' : 'login';
        render();
        break;
      case 'revoke':
        await api(`/workspaces/${state.workspace.id}/invitations/${button.dataset.id}`, 'DELETE', {});
        await refresh();
        render();
        message('Invitation revoked.');
        break;
    }
  });
});
root.addEventListener('change', event => {
  if (event.target.id === 'workspace-select')
    void run(async () => {
      await loadWorkspace(event.target.value);
      render();
    });
});

async function boot() {
  root.innerHTML = '<main class="foundation-main" role="status">Loading your account…</main>';
  state.user = null;
  state.csrfToken = '';
  state.workspace = null;
  state.workspaces = [];
  state.invite = null;
  state.token = '';
  state.view = 'login';
  state.setupAvailable = null;
  state.unsubscribeWorkspace = null;
  const setup = location.hash === '#setup';
  if (setup) state.view = 'setup';
  const hash = location.hash.slice(1).match(/^(invite|reset|unsubscribe)=([a-f0-9]{64})$/);
  if (hash) {
    state.token = hash[2];
    state.view = hash[1];
    history.replaceState(null, '', location.pathname + location.search);
  }
  try {
    try {
      if (hash?.[1] !== 'unsubscribe') await refresh();
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    if (setup) state.setupAvailable = (await api('/auth/setup')).available;
    else if (hash?.[1] === 'invite') state.invite = await api('/auth/invitations/inspect', 'POST', { token: state.token });
    else if (hash?.[1] === 'unsubscribe') state.unsubscribeWorkspace = (await api('/email/unsubscribe/inspect', 'POST', { token: state.token })).workspace;
    else if (!hash && state.user) state.view = 'workspace';
    render();
  } catch (error) {
    render();
    message(error.message, true);
  }
}
// Email links may be opened in an already-running tab without a document reload.
window.addEventListener('hashchange', () => {
  if (location.hash === '#setup' || /^#(invite|reset|unsubscribe)=[a-f0-9]{64}$/.test(location.hash)) void boot();
});
void boot();
