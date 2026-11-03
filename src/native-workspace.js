import './demo.js';
import { getWorkspaceSession } from './core/workspace-session.js';
import { A, IN } from './actions/actions.js';
import { render } from './shell/render.js';
import { toast } from './ui/toast.js';
import { readApiResponse } from './foundation/http.js';
import { S, proj, task, save, visibleProjects } from './core/store.js';
import { openModal } from './overlays/modals.js';
import { DRAG } from './actions/drag-drop.js';
import { createContentSync } from './core/content-sync.js';
import { localWorkspaceKey } from './core/workspace-session.js';
import { initCollaboration } from './core/collaboration-client.js';

const session = getWorkspaceSession();
session.contentRevision = session.content.revision;
try {
  session.draftBackup = JSON.parse(localStorage.getItem(localWorkspaceKey(session) + '.unsaved'));
} catch {
  /* A damaged browser backup must not stop server data from loading. */
}
let pointerEditing = false,
  deferredRender = false;
function renderSynced() {
  if (DRAG || pointerEditing || document.activeElement?.matches('input,textarea,[contenteditable=true]')) deferredRender = true;
  else {
    deferredRender = false;
    render();
  }
}
document.addEventListener('focusout', () => {
  if (deferredRender) setTimeout(renderSynced, 0);
});
document.addEventListener('pointerdown', event => {
  if (event.button === 0) pointerEditing = true;
});
function endPointerEdit() {
  pointerEditing = false;
  if (deferredRender) {
    deferredRender = false;
    // Let the click following pointerup reach its original target first.
    setTimeout(renderSynced, 0);
  }
}
window.addEventListener('pointerup', endPointerEdit);
document.addEventListener('dragend', endPointerEdit);
document.addEventListener('drop', endPointerEdit);
window.addEventListener('pointercancel', () => {
  if (!DRAG) endPointerEdit();
});
const sync = createContentSync({
  initial: session.content,
  capture: () => ({
    projects: S.data.projects,
    tasks: S.data.tasks,
    savedViews: S.data.savedViews,
    preferences: { prefs: S.prefs, views: S.views, collapsed: S.ui.collapsed, projectOrder: S.data.projOrder, notifPrefs: S.data.notifPrefs },
  }),
  request: async (method, body) => {
    try {
      return await readApiResponse(
        await fetch(`/api/workspaces/${session.workspace.id}/content`, {
          method,
          credentials: 'same-origin',
          headers: method === 'POST' ? { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken } : {},
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof TypeError && !error.status) throw new Error('Koneksi terputus. Perubahan belum tersimpan. Coba simpan lagi.');
      throw error;
    }
  },
  apply: content => {
    session.contentRevision = content.revision;
    const attachments = new Map(S.data.tasks.map(task => [task.id, task.attachments]));
    for (const key of ['projects', 'tasks', 'savedViews', 'activity']) S.data[key] = content[key];
    if (!session.collabPending || session.collabRefreshing) {
      S.data.files = content.files || [];
      S.data.notifs = content.notifs || [];
      S.data.commentTotals = content.commentTotals || {};
      const comments = new Map(S.data.comments.filter(comment => S.data.tasks.some(task => task.id === comment.task)).map(comment => [comment.id, comment]));
      for (const comment of content.comments || []) comments.set(comment.id, comment);
      S.data.comments = [...comments.values()].sort((a, b) => a.at - b.at);
    } else for (const task of S.data.tasks) task.attachments = attachments.get(task.id) || [];
    const ids = content.projects.map(p => p.id),
      order = content.preferences.projectOrder || [];
    S.data.projOrder = [...order.filter(id => ids.includes(id)), ...ids.filter(id => !order.includes(id))];
    if (content.preferences.views) S.views = content.preferences.views;
    if (content.preferences.prefs) Object.assign(S.prefs, content.preferences.prefs, { name: session.user.name });
    S.data.notifPrefs = content.preferences.notifPrefs || {};
    renderSynced();
  },
  status: (state, message) => {
    const previous = session.syncState;
    session.syncState = state;
    session.syncMessage = message;
    const element = document.querySelector('.native-sync-status');
    if (['error', 'conflict'].includes(state) || ['error', 'conflict'].includes(previous)) renderSynced();
    if (element)
      element.textContent =
        message ||
        { saving: 'Menyimpan ke database…', saved: 'Tersimpan di database', conflict: 'Konflik perubahan', error: 'Perubahan belum tersimpan' }[state];
  },
  backup: content => {
    session.draftBackup = JSON.parse(JSON.stringify(content));
    try {
      localStorage.setItem(localWorkspaceKey(session) + '.unsaved', JSON.stringify(content));
    } catch {
      /* Keep the unsaved content in memory too. */
    }
  },
});
session.scheduleSave = sync.schedule;
session.flush = sync.flush;
session.hasPendingChanges = sync.isDirty;
session.onRender = () => {
  if (sync.hasChanges()) sync.schedule();
};
let localDraft;
try {
  localDraft = JSON.parse(localStorage.getItem(localWorkspaceKey(session)))?.data;
} catch {
  /* No valid previous local draft. */
}
session.hasLocalDraft = !!localDraft?.projects?.some(project => !S.data.projects.some(current => current.id === project.id));
A.nativeImportLocal = () => {
  if (
    !localDraft ||
    !window.confirm(
      'Impor proyek dan task lokal akun ini ke database bersama? Data database yang sudah ada tidak akan ditimpa. File dan komentar tidak ikut diimpor.',
    )
  )
    return;
  for (const key of ['projects', 'tasks', 'savedViews']) {
    const ids = new Set(S.data[key].map(item => item.id));
    S.data[key].push(
      ...(localDraft[key] || []).filter(item => !ids.has(item.id)).map(item => (key === 'tasks' ? { ...item, attachments: [], recur: null } : item)),
    );
  }
  for (const project of S.data.projects)
    project.seq = Math.max(
      project.seq || 200,
      ...S.data.tasks.filter(task => task.project === project.id).map(task => Number(task.key.split('-').at(-1)) || 200),
    );
  S.data.projOrder = [...new Set([...S.data.projOrder, ...S.data.projects.map(project => project.id)])];
  session.hasLocalDraft = false;
  sync.schedule();
  render();
  void sync.flush().catch(() => {});
};
A.nativeDownloadDraft = () => {
  const data =
    sync.hasUnsavedContent() || !session.draftBackup ? { projects: S.data.projects, tasks: S.data.tasks, savedViews: S.data.savedViews } : session.draftBackup;
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'workspace-draft.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
A.nativeRetry = () => {
  void sync.retry().catch(() => {});
};
A.nativeRefresh = () => {
  void sync
    .refresh(true)
    .then(() => session.refreshComments?.())
    .catch(error => toast(error.message, { kind: 'err' }));
};
sync.schedule();
setInterval(() => {
  if (document.hidden || DRAG || pointerEditing || document.activeElement?.matches('input,textarea,[contenteditable=true]')) return;
  void sync
    .refresh()
    .then(() => session.refreshComments?.())
    .catch(() => {});
}, 10000);
window.addEventListener('beforeunload', event => {
  if (sync.hasUnsavedContent() || session.collabPending || S.ui.uploads?.length) {
    event.preventDefault();
    event.returnValue = '';
  }
});
const management = () => location.assign(`/?manage=1&workspace=${encodeURIComponent(session.workspace.id)}`);
const unavailable = () => toast('Fitur ini belum terhubung ke layanan akun. Gunakan Kelola workspace untuk pengaturan anggota.', { kind: 'info' });
A.nativeManage = management;
A.share = el => openModal({ type: 'share', id: el.dataset.id });
IN.nativeProjectPrivate = el => {
  proj(el.dataset.id).private = el.checked;
  save();
  render();
};
IN.nativeProjectMember = el => {
  const project = proj(el.dataset.id);
  project.members = el.checked ? [...new Set([...project.members, el.dataset.mid])] : project.members.filter(id => id !== el.dataset.mid);
  save();
  render();
};
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
A.popPick = el => {
  if (S.ui.pop?.type === 'recur' && el.dataset.v !== 'Does not repeat') {
    const target = S.ui.pop.id === '__form' ? S.ui.form : task(S.ui.pop.id);
    if (!target?.due) {
      toast('Tentukan deadline dahulu untuk task berulang.', { kind: 'info' });
      return;
    }
  }
  return S.ui.pop?.type === 'role' ? management() : pick(el);
};
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
A.signOut = async () => {
  try {
    if (session.collabPending) {
      toast('Tunggu sampai komentar atau upload selesai.', { kind: 'info' });
      return;
    }
    await sync.flush();
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
    /* Retry session verification on the next visibility/timer check. */
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void checkSession();
});
setInterval(checkSession, 60000);
initCollaboration({ session, sync, renderSynced });
render();
