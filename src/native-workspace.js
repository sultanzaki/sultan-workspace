import './demo.js';
import { getWorkspaceSession } from './core/workspace-session.js';
import { A, IN } from './actions/actions.js';
import { render } from './shell/render.js';
import { toast } from './ui/toast.js';
import { readApiResponse } from './foundation/http.js';
import { S, visibleProjects } from './core/store.js';

const session = getWorkspaceSession();
const management = () => location.assign(`/?manage=1&workspace=${encodeURIComponent(session.workspace.id)}`);
const unavailable = () => toast('Fitur ini belum terhubung ke layanan akun. Gunakan Kelola workspace untuk pengaturan anggota.', { kind: 'info' });
const noSharedFiles = () => toast('Penyimpanan isi file belum terhubung ke server. File belum diunggah.', { kind: 'info' });
A.nativeManage = management;
const newTask = A.newTask;
A.newTask = el => {
  if (!visibleProjects().length) {
    toast('Buat proyek terlebih dahulu untuk menambahkan task.', { kind: 'info' });
    A.newProject();
    return;
  }
  newTask(el);
};
const pick = A.popPick;
A.popPick = el => (S.ui.pop?.type === 'role' ? management() : pick(el));
A.switchWs = el => location.assign(`/?workspace=${encodeURIComponent(el.dataset.v)}`);
for (const key of [
  'newWorkspace',
  'newTeam',
  'editTeam',
  'submitTeam',
  'delTeam',
  'invite',
  'submitInvite',
  'resendInvite',
  'copyInviteLink',
  'removeMember',
  'saveWorkspace',
  'delWorkspace',
])
  A[key] = management;
for (const key of [
  'saveProfile',
  'savePassword',
  'revokeSession',
  'revokeAll',
  'setup2fa',
  'verify2fa',
  'disable2fa',
  'changePlan',
  'copyLink',
  'share',
  'shareAdd',
  'shareInvite',
  'resetDemo',
  'startOnboarding',
  'onbFinish',
  'doLogin',
  'doSignup',
  'socialAuth',
  'verified',
  'doReset',
  'doForgot',
  'resend',
  'auth',
])
  A[key] = unavailable;
IN.sharePerm = unavailable;
IN.shareAccess = unavailable;
IN.uploadFiles = noSharedFiles;
IN.formFiles = noSharedFiles;
A.signOut = async () => {
  try {
    const response = await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      body: '{}',
    });
    if (response.status !== 401) await readApiResponse(response);
    location.assign('/');
  } catch {
    toast('Logout belum berhasil. Periksa koneksi dan coba lagi.', { kind: 'err' });
  }
};
A.nativeSignOut = A.signOut;
async function checkSession() {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) location.assign('/');
    else if (response.ok) {
      const identity = await response.json();
      const workspace = identity.workspaces.find(workspace => workspace.id === session.workspace.id);
      if (identity.user.id !== session.user.id || !workspace || workspace.role !== session.workspace.role) location.assign('/');
      else session.csrfToken = identity.csrfToken;
    }
  } catch {
    /* Keep the explicit local-data notice visible during network loss. */
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void checkSession();
});
setInterval(checkSession, 60000);
render();
