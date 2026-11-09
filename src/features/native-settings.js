import { projectAllows } from '../core/permissions.js';
import { S } from '../core/store.js';
import { getWorkspaceSession } from '../core/workspace-session.js';
import { esc, fmtInstant } from '../core/utils.js';
import { av } from '../ui/helpers.js';

export const NATIVE_SETTINGS = ['profile', 'password', 'sessions', '2fa', 'workspace', 'members', 'teams', 'permissions', 'language', 'datetime'];
const input = (label, id, value = '', type = 'text', extra = '') =>
  `<div class="field"><label class="label" for="${id}">${label}</label><input class="input" id="${id}" type="${type}" value="${esc(value)}" ${extra}></div>`;
const button = (action, label, extra = '') => `<button class="btn btn-secondary" data-a="${action}" ${extra}>${label}</button>`;
const fieldPassword = () => input('Current password', 'native-current-password', '', 'password', 'autocomplete="current-password" maxlength="128"');
export function nativeSettingsBody(sec) {
  const session = getWorkspaceSession(),
    account = session.account,
    manager = ['owner', 'admin'].includes(session.workspace.role),
    role = session.workspace.role;
  if (['profile', 'password', 'sessions', '2fa'].includes(sec) && !account)
    return '<h1>Account settings</h1><p role="status">Loading account data…</p><button class="btn" data-a="nativeReloadAccount">Try again</button>';
  const user = account?.user || session.user,
    disabled = session.accountSaving ? 'disabled' : '';
  if (sec === 'profile')
    return `<h1>Profile</h1><form data-submit="nativeSaveProfile" class="col" style="max-width:480px;gap:14px"><div class="row" style="gap:12px">${av(S.data.me, 'lg', false)}<label class="btn btn-secondary">Upload photo<input type="file" accept="image/png,image/jpeg,image/webp" hidden data-in="nativeAvatar" aria-label="Upload profile photo"></label>${user.avatar ? button('nativeRemoveAvatar', 'Remove photo') : ''}</div><p class="faint">PNG, JPEG, or WebP; up to 256 KB.</p>${input('Full name', 'native-profile-name', user.name, 'text', 'maxlength="100" required')}${input('Job title', 'native-profile-title', user.title || '', 'text', 'maxlength="100"')}${input('Avatar color', 'native-profile-color', user.color || '#4B5BD6', 'color')}${input('Email', 'native-profile-email', user.email, 'email', 'readonly')}<button class="btn btn-primary" data-a="nativeSaveProfile" ${disabled}>Save profile</button></form>`;
  if (sec === 'password')
    return `<h1>Change password</h1><p class="lead">Changing your password revokes all sessions. You will need to sign in again.</p><form data-submit="nativeSavePassword" class="col" style="max-width:480px;gap:14px">${fieldPassword()}${input('New password', 'native-new-password', '', 'password', 'autocomplete="new-password" minlength="12" maxlength="128"')}${input('Confirm new password', 'native-confirm-password', '', 'password', 'autocomplete="new-password" minlength="12" maxlength="128"')}${account.mfa.enabled ? input('Two-factor or recovery code', 'native-factor', '', 'text', 'autocomplete="one-time-code" maxlength="64"') : ''}<button class="btn btn-primary" data-a="nativeSavePassword" ${disabled}>Change password</button></form>`;
  if (sec === 'sessions')
    return `<h1>Sign-in sessions</h1><p class="lead">Devices with active sessions for your account.</p>${button('nativeReloadAccount', 'Refresh')}${button('nativeRevokeOthers', 'Sign out other sessions')}<div class="stack" style="margin-top:16px">${(session.accountSessions || []).map(s => `<div class="panel" style="padding:14px"><div class="row"><b class="grow" style="overflow-wrap:anywhere">${esc(s.agent)}</b>${s.current ? '<span class="badge">This session</span>' : button('nativeRevokeSession', 'Revoke session', `data-id="${s.id}"`)}</div><p class="faint">Sign in ${esc(fmtInstant(s.createdAt, S.prefs))} · Expires ${esc(fmtInstant(s.expiresAt, S.prefs))}</p></div>`).join('')}</div>`;
  if (sec === '2fa') {
    const setup = session.mfaSetup,
      codes = session.recoveryCodes;
    if (codes)
      return `<h1>Two-factor recovery codes</h1><p class="lead">Store these codes securely. Each code can only be used once and is only shown now.</p><pre style="padding:16px;background:var(--surface-2)">${codes.map(esc).join('\n')}</pre>${button('nativeDownloadRecovery', 'Download recovery codes')}${button('nativeDismissRecovery', 'I have saved these codes')}`;
    if (setup)
      return `<h1>Connect authenticator</h1><p class="lead">Scan the QR code with your authenticator app, then enter the six-digit code.</p>${setup.qr ? `<img src="${esc(setup.qr)}" alt="Authenticator setup QR code" width="200" height="200">` : ''}<p><code style="overflow-wrap:anywhere">${esc(setup.secret)}</code></p><form data-submit="nativeConfirmMfa" class="col" style="max-width:400px;gap:12px">${input('Authenticator code', 'native-factor', '', 'text', 'inputmode="numeric" autocomplete="one-time-code" maxlength="6"')}<button class="btn btn-primary" data-a="nativeConfirmMfa" ${disabled}>Enable two-factor authentication</button>${button('nativeCancelMfa', 'Cancel')}</form>`;
    if (!account.mfa.enabled)
      return `<h1>Two-factor authentication</h1><p class="lead">Add an authenticator code alongside your password. No email is required.</p>${account.mfa.configured ? `<form data-submit="nativeSetupMfa" class="col" style="max-width:400px;gap:12px">${fieldPassword()}<button class="btn btn-primary" data-a="nativeSetupMfa" ${disabled}>Set up two-factor authentication</button></form>` : '<p>An administrator must configure AUTH_ENCRYPTION_KEY before two-factor authentication can be enabled.</p>'}`;
    return `<h1>Two-factor authentication enabled</h1><p class="lead">There are ${account.mfa.recoveryCodes} recovery codes remaining. Enter your password and a fresh code to continue.</p><div class="col" style="max-width:420px;gap:12px">${fieldPassword()}${input('Two-factor or recovery code', 'native-factor', '', 'text', 'autocomplete="one-time-code" maxlength="64"')}${button('nativeRegenerateRecovery', 'Regenerate recovery codes', disabled)}${button('nativeDisableMfa', 'Disable two-factor authentication', disabled)}</div>`;
  }
  if (sec === 'workspace')
    return `<h1>Workspace</h1><div class="col" style="max-width:480px;gap:14px">${input('Workspace name', 'native-workspace-name', S.data.ws.name, 'text', manager ? 'maxlength="100"' : 'readonly')}${input('Workspace URL slug', 'native-workspace-slug', session.workspace.slug || '', 'text', manager ? 'minlength="3" maxlength="60" placeholder="e.g. sultan-team"' : 'readonly')}${input('Workspace color', 'native-workspace-color', S.data.ws.c, 'color', manager ? '' : 'disabled')}<p style="overflow-wrap:anywhere">${esc(location.origin)}/?workspace=${esc(session.workspace.slug || session.workspace.id)}</p>${manager ? `<button class="btn btn-primary" data-a="nativeSaveWorkspace">Save workspace</button>` : ''}</div>${role === 'owner' ? `<div class="sblock"><h2>Delete workspace</h2><p>All projects, tasks, files, and comments in this workspace will be permanently deleted.</p><button class="btn btn-danger" data-a="nativeDeleteWorkspace">Delete workspace</button></div>` : ''}`;
  if (sec === 'members')
    return `<h1>Workspace members</h1>${manager ? `${button('nativeInvite', 'Invite member')}${button('nativeLoadAdministration', 'Refresh')}` : ''}<div class="stack" style="margin-top:14px">${S.data.members.map(m => `<div class="panel native-member-row" style="padding:12px;gap:10px">${av(m.id, 'md', false)}<div class="native-member-identity"><b>${esc(m.name)}</b><div class="faint">${esc(m.email)} · ${m.status === 'active' ? 'Active' : 'Inactive'}</div></div>${manager ? `<select class="select" data-in="nativeMemberRole" data-id="${m.id}" ${role !== 'owner' && ['Owner', 'Admin'].includes(m.role) ? 'disabled' : ''} aria-label="Role ${esc(m.name)}">${(role === 'owner' ? ['owner', 'admin', 'member', 'guest'] : ['Owner', 'Admin'].includes(m.role) ? [m.role.toLowerCase()] : ['member', 'guest']).map(r => `<option value="${r}" ${r === m.role.toLowerCase() ? 'selected' : ''}>${r}</option>`).join('')}</select>${button('nativeMemberToggle', m.status === 'active' ? 'Deactivate' : 'Activate', `data-id="${m.id}" ${role !== 'owner' && ['Owner', 'Admin'].includes(m.role) ? 'disabled' : ''}`)}` : `<span class="badge">${esc(m.role)}</span>`}</div>`).join('')}</div>${manager ? `<h2 style="margin-top:20px">Active invitations</h2>${(session.invitations || []).map(i => `<div class="panel native-invitation-row" style="padding:12px"><span class="native-invitation-identity">${esc(i.email)} · ${esc(i.role)} · ${esc(i.delivery)}</span>${session.features.email ? button('nativeResendInvitation', 'Resend email', `data-id="${i.id}"`) : ''}${button('nativeRenewInvitation', 'Create new link', `data-id="${i.id}"`)}${button('nativeRevokeInvitation', 'Revoke', `data-id="${i.id}"`)}</div>`).join('') || '<p>No active invitations.</p>'}` : ''}`;
  if (sec === 'teams')
    return `<h1>Team</h1>${manager ? button('nativeNewTeam', 'Create team') : ''}<div class="stack" style="margin-top:14px">${S.data.teams.map(t => `<div class="panel" style="padding:14px"><div class="row"><h2 class="grow">${esc(t.name)}</h2>${manager ? button('nativeEditTeam', 'Edit team', `data-id="${t.id}"`) + button('nativeDeleteTeam', 'Delete team', `data-id="${t.id}"`) : ''}</div><p>${t.members.map(id => esc(S.data.members.find(m => m.id === id)?.name || '')).join(', ') || 'No members yet.'}</p></div>`).join('') || '<p>No teams yet.</p>'}</div>`;
  if (sec === 'permissions')
    return `<h1>Permissions and access requests</h1>${manager ? `<div class="sblock"><label class="row"><input type="checkbox" data-in="nativeWorkspacePolicy" data-key="membersCanCreateProjects" ${S.data.ws.settings.membersCanCreateProjects !== false ? 'checked' : ''}>Internal members can create projects</label><label class="row"><input type="checkbox" data-in="nativeWorkspacePolicy" data-key="leadCanInviteGuests" ${S.data.ws.settings.leadCanInviteGuests ? 'checked' : ''}>Project leads can invite guests to their projects</label></div>` : ''}<p>Viewers can read, commenters can discuss, and editors can edit tasks, events, and files. Project leads, owners, and administrators manage access.</p>${button('nativeLoadAdministration', 'Load access requests')}<div class="stack" style="margin-top:14px">${(session.accessRequests || []).map(r => `<div class="panel" style="padding:12px"><div><b>${esc(r.projectName)}</b> · ${esc(r.name)} · ${esc(r.permission)} · ${esc(r.status)}</div><p>${esc(r.reason)}</p>${r.canDecide && r.status === 'pending' ? button('nativeApproveAccess', 'Approve', `data-id="${r.id}"`) + button('nativeRejectAccess', 'Reject', `data-id="${r.id}"`) : ''}</div>`).join('') || '<p>No requests yet.</p>'}</div>`;
  if (sec === 'language')
    return `<h1>Language</h1><label class="label" for="native-language">Interface language</label><select class="select" id="native-language" data-in="prefSel" data-k="lang"><option value="en-US" ${!['id-ID', 'Bahasa Indonesia'].includes(S.prefs.lang) ? 'selected' : ''}>English</option><option value="id-ID" ${['id-ID', 'Bahasa Indonesia'].includes(S.prefs.lang) ? 'selected' : ''}>Bahasa Indonesia</option></select><p class="faint">Project content, tasks, and comments are not translated.</p><label class="row"><input type="checkbox" data-in="prefToggle" data-k="spell" ${S.prefs.spell !== false ? 'checked' : ''}>Spellcheck</label>`;
  if (sec === 'datetime')
    return `<h1>Date and time</h1><div class="col" style="max-width:450px;gap:14px"><label class="label" for="native-timezone">Time zone</label><select class="select" id="native-timezone" data-in="prefSel" data-k="tz">${['UTC', 'Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'Pacific/Auckland'].map(zone => `<option value="${zone}" ${S.prefs.tz === zone ? 'selected' : ''}>${zone}</option>`).join('')}</select><label class="label" for="native-dateformat">Date format</label><select class="select" id="native-dateformat" data-in="prefSel" data-k="dateFmt">${[
      ['MMM d', 'Jan 31'],
      ['d/M', '31/1'],
      ['M/d', '1/31'],
      ['yyyy-MM-dd', '2037-01-31'],
    ]
      .map(([v, label]) => `<option value="${v}" ${S.prefs.dateFmt === v ? 'selected' : ''}>${label}</option>`)
      .join(
        '',
      )}</select><label class="label" for="native-weekstart">Start of week</label><select class="select" id="native-weekstart" data-in="prefSel" data-k="weekStart">${[
      [0, 'Sunday'],
      [1, 'Monday'],
      [6, 'Saturday'],
    ]
      .map(([v, label]) => `<option value="${v}" ${S.prefs.weekStart === v ? 'selected' : ''}>${label}</option>`)
      .join(
        '',
      )}</select><label class="label" for="native-timeformat">Time format</label><select class="select" id="native-timeformat" data-in="prefSel" data-k="timeFmt"><option value="12" ${S.prefs.timeFmt !== '24' ? 'selected' : ''}>12 hours</option><option value="24" ${S.prefs.timeFmt === '24' ? 'selected' : ''}>24 hours</option></select></div>`;
  return '';
}

export function nativeAdminModal(m, H) {
  const session = getWorkspaceSession();
  const footer = (action, label) =>
    `<div class="modal-f"><span class="sp"></span>${button('closeModal', 'Cancel')}<button class="btn btn-primary" data-a="${action}" ${m.saving ? 'disabled' : ''}>${m.saving ? 'Saving…' : label}</button></div>`;
  if (m.kind === 'invite')
    return `${H('Invite member')}<div class="modal-b col" style="gap:12px">${input('Recipient email', 'native-invite-email', m.email || '', 'email', 'autocomplete="off"')}<label class="label" for="native-invite-role">Role</label><select class="select" id="native-invite-role" data-in="nativeInviteRole">${(session.workspace.role === 'owner' ? ['member', 'admin', 'guest'] : session.workspace.role === 'admin' ? ['member', 'guest'] : ['guest']).map(role => `<option value="${role}" ${m.role === role ? 'selected' : ''}>${role}</option>`).join('')}</select><label class="label" for="native-invite-delivery">Delivery</label><select class="select" id="native-invite-delivery"><option value="link" ${m.delivery !== 'email' ? 'selected' : ''}>Manual link (no email)</option>${session.features?.email ? `<option value="email" ${m.delivery === 'email' ? 'selected' : ''}>Send email</option>` : ''}</select>${
      m.role === 'guest'
        ? `<label class="label" for="native-invite-project">Guest project</label><select class="select" id="native-invite-project">${S.data.projects
            .filter(p => !p.archived && projectAllows(p, session.user.id, session.workspace.role, 'manage'))
            .map(p => `<option value="${p.id}" ${p.id === m.project ? 'selected' : ''}>${esc(p.name)}</option>`)
            .join(
              '',
            )}</select><label class="label" for="native-invite-permission">Project permission</label><select class="select" id="native-invite-permission"><option value="viewer">View</option><option value="commenter">Comment</option><option value="editor">Edit</option></select>`
        : ''
    }</div>${footer('nativeSubmitInvite', 'Create invitation')}`;
  if (m.kind === 'inviteLink')
    return `${H('Invitation link ready')}<div class="modal-b"><p>This link is shown only once. Share it directly with the recipient. It expires in 48 hours and can only be used once.</p><textarea class="textarea" id="native-invitation-link" rows="3" readonly>${esc(m.url)}</textarea></div>${footer('nativeCopyInvitation', 'Copy link')}`;
  if (m.kind === 'team')
    return `${H(m.id ? 'Edit team' : 'Create team')}<div class="modal-b">${input('Team name', 'native-team-name', m.name || '', 'text', 'maxlength="100"')}<h3>Team members</h3>${S.data.members
      .filter(u => u.status === 'active' && u.role !== 'Guest')
      .map(
        u =>
          `<label class="row" style="padding:6px 0"><input type="checkbox" data-team-member="${u.id}" ${(m.members || []).includes(u.id) ? 'checked' : ''}>${esc(u.name)}</label>`,
      )
      .join('')}</div>${footer('nativeSaveTeam', 'Save team')}`;
  if (m.kind === 'workspace')
    return `${H('Create workspace')}<div class="modal-b">${input('New workspace name', 'native-workspace-new', '', 'text', 'maxlength="100"')}</div>${footer('nativeCreateWorkspace', 'Create workspace')}`;
  if (m.kind === 'deleteWorkspace')
    return `${H('Permanently delete workspace')}<div class="modal-b"><p>Enter the workspace name and your password to delete all its data.</p>${input('Confirmation name', 'native-delete-name')}${fieldPassword()}${session.account?.mfa.enabled ? input('Two-factor or recovery code', 'native-factor', '', 'text', 'autocomplete="one-time-code"') : ''}</div>${footer('nativeConfirmDeleteWorkspace', 'Delete permanently')}`;
  if (m.kind === 'access')
    return `${H('Request project access')}<div class="modal-b"><p>${esc(S.data.projects.find(p => p.id === m.project)?.name || m.project)}</p><label class="label">Requested permission</label><select class="select" id="native-request-permission"><option value="viewer">View</option><option value="commenter">Comment</option><option value="editor" selected>Edit</option></select><label class="label" for="native-request-reason">Reason</label><textarea class="textarea" id="native-request-reason" maxlength="1000" rows="3"></textarea></div>${footer('nativeSubmitAccessRequest', 'Send request')}`;
  return '';
}
