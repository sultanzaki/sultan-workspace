import { A, IN, confirmDlg } from '../actions/actions.js';
import { S, proj } from './store.js';
import { go, render } from '../shell/render.js';
import { openModal } from '../overlays/modals.js';
import { nativeApi } from './native-api.js';
import { toast } from '../ui/toast.js';

export function initAdministration({ session, renderSynced }) {
  const base = `/workspaces/${session.workspace.id}`,
    api = (path, method, body) => nativeApi(session, path, method, body),
    value = id => document.getElementById(id)?.value || '';
  const manager = () => ['owner', 'admin'].includes(session.workspace.role);
  let loadingMail = false,
    lastMail = 0;
  async function loadMail() {
    if (!manager() || loadingMail) return;
    loadingMail = true;
    lastMail = Date.now();
    try {
      session.mailStatus = await api(base + '/mail-status');
      session.mailLoaded = true;
      renderSynced();
    } catch (error) {
      toast(error.message, { kind: 'err' });
    } finally {
      loadingMail = false;
    }
  }
  A.nativeLoadMail = () => {
    void loadMail();
  };
  A.nativeRetryMail = el => {
    void session.perform(async () => {
      await api(base + '/mail/' + el.dataset.id + '/retry', 'POST', {});
      await loadMail();
    });
  };
  let loading = false,
    lastAttempt = 0;
  async function loadAdministration() {
    if (loading) return;
    loading = true;
    lastAttempt = Date.now();
    try {
      const [invitations, access] = await Promise.all([manager() ? api(base + '/invitations') : Promise.resolve([]), api(base + '/access-requests')]);
      session.invitations = invitations;
      session.accessRequests = access;
      renderSynced();
    } catch (error) {
      toast(error.message, { kind: 'err' });
    } finally {
      loading = false;
    }
  }
  A.nativeLoadAdministration = () => {
    void loadAdministration();
  };
  const previous = session.onRender;
  session.onRender = () => {
    previous?.();
    if (S.ui.route === 'settings' && S.ui.params.sec === 'notif-email' && Date.now() - lastMail > 30000 && !loadingMail) void loadMail();
    if (S.ui.route === 'settings' && ['members', 'teams', 'permissions'].includes(S.ui.params.sec) && Date.now() - lastAttempt > 30000 && !loading)
      void loadAdministration();
  };
  function modalRun(modal, fn) {
    if (modal?.saving) return;
    modal.saving = true;
    return session
      .perform(async () => {
        const result = await fn();
        if (result?.redirect) return result;
        if (!result?.keepOpen && S.ui.modals.at(-1) === modal) S.ui.modals.pop();
        await loadAdministration();
      })
      .finally(() => {
        modal.saving = false;
        renderSynced();
      });
  }
  A.nativeManage = () => go('settings', { sec: 'members' });
  A.nativeInvite = el =>
    openModal({ type: 'nativeAdmin', kind: 'invite', role: el?.dataset.project ? 'guest' : 'member', project: el?.dataset.project, email: '' });
  A.invite = A.nativeInvite;
  IN.nativeInviteRole = el => {
    const modal = S.ui.modals.at(-1);
    modal.email = value('native-invite-email');
    modal.delivery = value('native-invite-delivery');
    modal.role = el.value;
    render();
  };
  A.nativeSubmitInvite = () => {
    const modal = S.ui.modals.at(-1),
      input = { email: value('native-invite-email'), role: value('native-invite-role'), delivery: value('native-invite-delivery') };
    if (input.role === 'guest') {
      input.project = value('native-invite-project');
      input.permission = value('native-invite-permission');
    }
    if (!input.email) {
      toast("Enter the recipient's email address.", { kind: 'err' });
      return;
    }
    void modalRun(modal, async () => {
      const result = await api(base + '/invitations', 'POST', input);
      if (result.url) {
        modal.kind = 'inviteLink';
        modal.url = result.url;
        await loadAdministration();
        return { keepOpen: true };
      }
      toast(result.message, { kind: 'info' });
    });
  };
  A.nativeCopyInvitation = () => {
    const url = S.ui.modals.at(-1)?.url;
    if (!url) return;
    void navigator.clipboard
      .writeText(url)
      .then(() => toast('Link disalin.', { kind: 'info' }))
      .catch(() => {
        document.getElementById('native-invitation-link')?.select();
        toast('Select and copy the link from the invitation box.', { kind: 'info' });
      });
  };
  A.nativeResendInvitation = el => {
    const invitation = session.invitations?.find(i => i.id === el.dataset.id);
    if (!invitation) return;
    void session.perform(async () => {
      const input = {
        email: invitation.email,
        role: invitation.role,
        delivery: 'email',
        ...(invitation.project_id ? { project: invitation.project_id, permission: invitation.project_permission } : {}),
      };
      const result = await api(base + '/invitations', 'POST', input);
      toast(result.message || 'Invitation email queued.', { kind: 'info' });
      await loadAdministration();
    });
  };
  A.nativeRenewInvitation = el => {
    const invitation = session.invitations?.find(i => i.id === el.dataset.id);
    if (!invitation) return;
    void session.perform(async () => {
      const input = {
        email: invitation.email,
        role: invitation.role,
        delivery: 'link',
        ...(invitation.project_id ? { project: invitation.project_id, permission: invitation.project_permission } : {}),
      };
      const result = await api(base + '/invitations', 'POST', input);
      openModal({ type: 'nativeAdmin', kind: 'inviteLink', url: result.url });
      await loadAdministration();
    });
  };
  A.nativeRevokeInvitation = el => {
    void session.perform(async () => {
      await api(base + `/invitations/${el.dataset.id}`, 'DELETE');
      await loadAdministration();
    });
  };
  A.resendInvite = el => (session.features.email ? A.nativeResendInvitation(el) : A.nativeRenewInvitation(el));
  IN.nativeMemberRole = el => {
    const target = el.dataset.id,
      role = el.value;
    void session.perform(async () => {
      await api(base + `/members/${target}`, 'PATCH', { role });
      if (target === session.user.id) return { redirect: '/?workspace=' + session.workspace.id };
    });
  };
  A.nativeMemberToggle = el => {
    const member = S.data.members.find(m => m.id === el.dataset.id);
    if (!member) return;
    const active = member.status !== 'active';
    confirmDlg({
      title: active ? 'Activate member?' : 'Deactivate member?',
      body: active ? 'The member will regain access according to their role.' : "The member's sessions will be revoked.",
      ok: active ? 'Activate' : 'Deactivate',
      run: () =>
        session.perform(async () => {
          await api(base + `/members/${member.id}`, 'PATCH', { active });
          if (member.id === session.user.id) return { redirect: '/' };
        }),
    });
  };
  A.removeMember = el => A.nativeMemberToggle(el);
  A.nativeNewTeam = () => openModal({ type: 'nativeAdmin', kind: 'team', name: '', members: [] });
  A.newTeam = A.nativeNewTeam;
  A.nativeEditTeam = el => {
    const team = S.data.teams.find(t => t.id === el.dataset.id);
    if (team) openModal({ type: 'nativeAdmin', kind: 'team', ...structuredClone(team) });
  };
  A.editTeam = A.nativeEditTeam;
  A.nativeSaveTeam = () => {
    const modal = S.ui.modals.at(-1),
      input = { name: value('native-team-name'), members: [...document.querySelectorAll('[data-team-member]:checked')].map(el => el.dataset.teamMember) };
    if (!input.name.trim()) {
      toast('Team name cannot be empty.', { kind: 'err' });
      return;
    }
    void modalRun(modal, () => api(base + '/teams' + (modal.id ? '/' + modal.id : ''), modal.id ? 'PATCH' : 'POST', input));
  };
  A.nativeDeleteTeam = el =>
    confirmDlg({
      title: 'Delete team?',
      body: 'Projects and tasks will be kept. Their link to this team will be removed.',
      ok: 'Delete team',
      danger: true,
      run: () => session.perform(() => api(base + `/teams/${el.dataset.id}`, 'DELETE')),
    });
  A.delTeam = A.nativeDeleteTeam;
  A.nativeSaveWorkspace = () => {
    const input = {
      name: value('native-workspace-name'),
      slug: value('native-workspace-slug').trim() || null,
      settings: { color: value('native-workspace-color') },
    };
    void session.perform(() => api(base, 'PATCH', input));
  };
  A.saveWorkspace = A.nativeSaveWorkspace;
  IN.nativeWorkspacePolicy = el => {
    const key = el.dataset.key,
      checked = el.checked;
    void session.perform(() => api(base, 'PATCH', { settings: { [key]: checked } }));
  };
  A.newWorkspace = () => openModal({ type: 'nativeAdmin', kind: 'workspace' });
  A.nativeCreateWorkspace = () => {
    const modal = S.ui.modals.at(-1),
      name = value('native-workspace-new');
    void modalRun(modal, async () => {
      const ws = await api('/workspaces', 'POST', { name });
      return { redirect: '/?workspace=' + ws.id };
    });
  };
  A.nativeDeleteWorkspace = () => openModal({ type: 'nativeAdmin', kind: 'deleteWorkspace' });
  A.delWorkspace = A.nativeDeleteWorkspace;
  A.nativeConfirmDeleteWorkspace = () => {
    const modal = S.ui.modals.at(-1),
      input = { name: value('native-delete-name'), currentPassword: value('native-current-password'), code: value('native-factor') };
    void modalRun(modal, async () => {
      await api(base, 'DELETE', input);
      return { redirect: '/?manage=1' };
    });
  };
  session.requestProjectAccess = project => openModal({ type: 'nativeAdmin', kind: 'access', project });
  A.nativeRequestAccess = el => session.requestProjectAccess(el.dataset.id);
  A.requestAccess = A.nativeRequestAccess;
  A.nativeSubmitAccessRequest = () => {
    const modal = S.ui.modals.at(-1),
      input = { project: modal.project, permission: value('native-request-permission'), reason: value('native-request-reason') };
    void modalRun(modal, () => api(base + '/access-requests', 'POST', input));
  };
  for (const [action, approve] of [
    ['nativeApproveAccess', true],
    ['nativeRejectAccess', false],
  ])
    A[action] = el => {
      void session.perform(async () => {
        await api(base + `/access-requests/${el.dataset.id}/decision`, 'POST', { approve });
        await loadAdministration();
      });
    };
  A.nativeProjectPermission = el => {
    const project = proj(el.dataset.id),
      user = el.dataset.user;
    if (!project) return;
    project.permissions = { ...project.permissions, [user]: el.value };
    session.scheduleSave();
    render();
  };
  IN.nativeProjectPermission = A.nativeProjectPermission;
}
