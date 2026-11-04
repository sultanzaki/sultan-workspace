import { A, IN, confirmDlg } from '../actions/actions.js';
import { S, proj, task } from './store.js';
import { localWorkspaceKey } from './workspace-session.js';
import { readApiResponse } from '../foundation/http.js';
import { openModal } from '../overlays/modals.js';
import { go, render } from '../shell/render.js';
import { toast } from '../ui/toast.js';
import { fileType, fsize } from '../ui/helpers.js';

export function initCollaboration({ session, sync, renderSynced }) {
  const base = `/api/workspaces/${session.workspace.id}`;
  const draftKey = localWorkspaceKey(session) + '.comment-drafts';
  let drafts = {};
  try {
    drafts = JSON.parse(localStorage.getItem(draftKey)) || {};
  } catch {
    /* Ignore a damaged local draft. */
  }
  for (const [id, draft] of Object.entries(drafts)) if (task(id)) S.ui.drafts[id] = draft.text;
  function persistDrafts() {
    try {
      localStorage.setItem(draftKey, JSON.stringify(drafts));
    } catch {
      /* Draft remains in memory. */
    }
  }
  async function request(path, method = 'GET', body) {
    if (method !== 'GET') body ??= {};
    try {
      return await readApiResponse(
        await fetch(base + path, {
          method,
          credentials: 'same-origin',
          headers: method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof TypeError) throw new Error('Koneksi terputus. Perubahan belum dikonfirmasi server. Coba lagi.');
      throw error;
    }
  }
  let chain = Promise.resolve();
  function perform(fn, onError) {
    session.collabPending = (session.collabPending || 0) + 1;
    const result = chain.then(async () => {
      await sync.flush();
      await fn();
      await sync.flush();
      session.collabRefreshing = true;
      try {
        await sync.refresh();
      } finally {
        session.collabRefreshing = false;
      }
    });
    chain = result
      .catch(error => {
        onError?.(error);
        toast(error.message, { kind: 'err' });
      })
      .finally(() => {
        session.collabPending--;
        renderSynced();
      });
    return chain;
  }
  const updateComment = comment => {
    const i = S.data.comments.findIndex(item => item.id === comment.id);
    if (i < 0) S.data.comments.push(comment);
    else S.data.comments[i] = comment;
    S.data.comments.sort((a, b) => a.at - b.at);
  };
  const updateFile = file => {
    S.data.files = S.data.files.filter(item => item.id !== file.id);
    S.data.files.push(file);
    for (const t of S.data.tasks) t.attachments = S.data.files.filter(item => item.task === t.id);
  };
  S.ui.commentPages = {};
  let commentLoading = new Set();
  async function loadComments(id, more = false) {
    if (!id || !task(id) || commentLoading.has(id)) return;
    commentLoading.add(id);
    try {
      const cursor = more ? S.ui.commentPages[id]?.nextCursor : null;
      const data = await request(`/tasks/${encodeURIComponent(id)}/comments${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`);
      if (!more) {
        const oldest = data.nextCursor ? data.comments[0]?.at : -Infinity;
        S.data.comments = S.data.comments.filter(comment => comment.task !== id || comment.at < oldest);
      }
      for (const comment of data.comments) updateComment(comment);
      S.ui.commentPages[id] = { nextCursor: data.nextCursor, loaded: true };
      renderSynced();
    } catch (error) {
      toast(error.message, { kind: 'err' });
    } finally {
      commentLoading.delete(id);
    }
  }
  const openTask = A.openTask;
  A.openTask = el => {
    openTask(el);
    void loadComments(el.dataset.id);
  };
  A.nativeMoreComments = el => {
    void loadComments(el.dataset.id, true);
  };
  session.refreshComments = () => {
    const id = S.ui.drawer || S.data.notifs.find(n => n.id === S.ui.inboxSel)?.task;
    if (id && !document.activeElement?.matches('input,textarea,[contenteditable=true]')) void loadComments(id);
  };
  const draft = IN.draft;
  IN.draft = el => {
    draft(el);
    const previous = drafts[el.dataset.id];
    drafts[el.dataset.id] = { text: el.value, id: previous?.text === el.value ? previous.id : crypto.randomUUID(), mentions: previous?.mentions || [] };
    persistDrafts();
  };
  const pickMention = A.pickMention;
  A.pickMention = el => {
    pickMention(el);
    const previous = drafts[el.dataset.id] || {};
    drafts[el.dataset.id] = {
      text: S.ui.drafts[el.dataset.id],
      id: crypto.randomUUID(),
      mentions: [...new Set([...(previous.mentions || []), el.dataset.mid].filter(Boolean))],
    };
    persistDrafts();
  };
  S.ui.postingComments = new Set();
  A.postComment = el => {
    const id = el.dataset.id,
      text = (S.ui.drafts[id] || '').trim();
    if (!text || S.ui.postingComments.has(id)) return;
    const old = drafts[id];
    const input = { id: old?.text.trim() === text ? old.id : crypto.randomUUID(), text, mentions: old?.mentions || [] };
    drafts[id] = { ...input, text };
    persistDrafts();
    S.ui.postingComments.add(id);
    const buttons = () => document.querySelectorAll(`[data-a="postComment"][data-id="${CSS.escape(id)}"]`);
    buttons().forEach(button => {
      button.disabled = true;
    });
    void perform(async () => {
      const comment = await request(`/tasks/${encodeURIComponent(id)}/comments`, 'POST', input);
      updateComment(comment);
      if ((S.ui.drafts[id] || '').trim() === text) {
        S.ui.drafts[id] = '';
        delete drafts[id];
        persistDrafts();
        document.querySelectorAll('#d-cmt,#inbox-reply').forEach(field => {
          if (field.dataset.id === id) field.value = '';
        });
      }
      S.ui.mention = null;
      S.ui.drawerTab = 'comments';
      await loadComments(id);
    }).finally(() => {
      S.ui.postingComments.delete(id);
      buttons().forEach(button => {
        button.disabled = false;
      });
      renderSynced();
    });
  };
  A.editComment = el => {
    const comment = S.data.comments.find(item => item.id === el.dataset.id);
    if (comment) openModal({ type: 'nativeCommentEdit', comment: comment.id, text: comment.text, version: comment.version });
  };
  IN.nativeCommentEdit = el => {
    const modal = S.ui.modals.at(-1);
    if (modal?.type === 'nativeCommentEdit') modal.text = el.value;
  };
  A.nativeSaveComment = () => {
    const modal = S.ui.modals.at(-1);
    if (modal?.type !== 'nativeCommentEdit' || modal.saving) return;
    const text = modal.text.trim();
    if (!text) return;
    modal.saving = true;
    render();
    void perform(async () => {
      const comment = await request(`/comments/${modal.comment}`, 'PATCH', { text, version: modal.version, mentions: [] });
      updateComment(comment);
      if (S.ui.modals.at(-1) === modal) S.ui.modals.pop();
    }).finally(() => {
      modal.saving = false;
      renderSynced();
    });
  };
  A.delComment = el => {
    const comment = S.data.comments.find(item => item.id === el.dataset.id);
    if (!comment) return;
    confirmDlg({
      title: 'Hapus komentar?',
      body: 'Komentar ini akan dihapus dari percakapan bersama.',
      ok: 'Hapus komentar',
      danger: true,
      run: () =>
        perform(async () => {
          await request(`/comments/${comment.id}`, 'DELETE');
          S.data.comments = S.data.comments.filter(item => item.id !== comment.id);
          await loadComments(comment.task);
        }),
    });
  };
  A.react = el => {
    const comment = S.data.comments.find(item => item.id === el.dataset.id);
    if (!comment) return;
    const present = !(comment.re[el.dataset.e] || []).includes(session.user.id);
    S.ui.pop = null;
    void perform(async () => updateComment(await request(`/comments/${comment.id}/reactions`, 'POST', { emoji: el.dataset.e, present })));
  };
  S.ui.uploads = [];
  const fileContents = file =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('File tidak dapat dibaca.'));
      reader.readAsDataURL(file);
    });
  function upload(entry) {
    if (entry.uploading) return Promise.resolve();
    entry.uploading = true;
    entry.error = '';
    renderSynced();
    return perform(
      async () => {
        try {
          entry.content ||= await fileContents(entry.file);
          const file = await request('/files', 'POST', {
            id: entry.id,
            project: entry.project,
            task: entry.task || null,
            name: entry.name,
            content: entry.content,
          });
          updateFile(file);
          S.ui.uploads = S.ui.uploads.filter(item => item !== entry);
        } catch (error) {
          entry.error = error.message;
          throw error;
        }
      },
      error => {
        entry.error = error.message;
      },
    ).finally(() => {
      entry.uploading = false;
      renderSynced();
    });
  }
  session.uploadFiles = (files, ctx) => {
    const pending = [];
    for (const file of files || []) {
      if (file.size > 3 * 1024 * 1024 || !file.size) {
        toast(`${file.name}: ukuran file harus 1 B sampai 3 MB.`, { kind: 'err' });
        continue;
      }
      const entry = { id: crypto.randomUUID(), name: file.name, project: ctx.project, task: ctx.task || null, file };
      S.ui.uploads.push(entry);
      pending.push(upload(entry));
    }
    renderSynced();
    return Promise.all(pending);
  };
  IN.uploadFiles = el => {
    void session.uploadFiles(el.files, { project: el.dataset.project, task: el.dataset.task });
    el.value = '';
  };
  A.nativeRetryUpload = el => {
    const entry = S.ui.uploads.find(item => item.id === el.dataset.id);
    if (entry) void upload(entry);
  };
  A.nativeDiscardUpload = el => {
    S.ui.uploads = S.ui.uploads.filter(item => item.id !== el.dataset.id || item.uploading);
    render();
  };
  IN.formFiles = el => {
    for (const file of el.files || [])
      if (file.size && file.size <= 3 * 1024 * 1024) S.ui.form.files.push({ name: file.name, size: fsize(file.size), type: fileType(file.name), file });
      else toast(`${file.name}: maksimal 3 MB per file.`, { kind: 'err' });
    render();
  };
  const submitTask = A.submitTask;
  A.submitTask = () => {
    if (S.ui.form.recur && !S.ui.form.due) {
      toast('Tentukan deadline dahulu untuk task berulang.', { kind: 'info' });
      return;
    }
    const modal = S.ui.modals.at(-1),
      form = S.ui.form,
      files = form.files,
      ids = new Set(S.data.tasks.map(t => t.id));
    form.files = [];
    submitTask();
    if (S.ui.errors.title) {
      form.files = files;
      render();
      return;
    }
    const created = modal.edit ? task(modal.edit) : S.data.tasks.find(item => !ids.has(item.id));
    if (created && files.length)
      void session.uploadFiles(
        files.map(item => item.file),
        { project: created.project, task: created.id },
      );
  };
  const removeFile = file =>
    confirmDlg({
      title: 'Hapus file?',
      body: 'File asli akan dihapus dari proyek dan lampiran task.',
      ok: 'Hapus file',
      danger: true,
      run: () =>
        perform(async () => {
          await request(`/files/${file.id}`, 'DELETE');
          S.data.files = S.data.files.filter(item => item.id !== file.id);
          for (const t of S.data.tasks) t.attachments = t.attachments.filter(item => item.id !== file.id);
        }),
    });
  A.rmAttach = el => {
    const file = S.data.files.find(item => item.id === el.dataset.aid);
    if (file) removeFile(file);
  };
  A.delFile = el => {
    const file = S.data.files.find(item => item.id === el.dataset.id);
    if (file) removeFile(file);
  };
  A.renameFile = el => {
    const file = S.data.files.find(item => item.id === el.dataset.id);
    S.ui.pop = null;
    if (file)
      openModal({
        type: 'prompt',
        title: 'Rename file',
        label: 'File name',
        value: file.name,
        run: name => perform(async () => updateFile(await request(`/files/${file.id}`, 'PATCH', { name }))),
      });
  };
  A.dupFile = el => {
    S.ui.pop = null;
    void perform(async () => updateFile(await request(`/files/${el.dataset.id}/copy`, 'POST', { id: crypto.randomUUID() })));
  };
  A.nativeDownloadFile = el => {
    const file = S.data.files.find(item => item.id === el.dataset.id);
    if (!file) return;
    void requestDownload(file);
  };
  async function requestDownload(file) {
    try {
      const response = await fetch(file.url, { credentials: 'same-origin' });
      if (!response.ok) {
        await readApiResponse(response);
        return;
      }
      const url = URL.createObjectURL(await response.blob()),
        link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      toast(error.message || 'File gagal diunduh.', { kind: 'err' });
    }
  }
  function read(ids, all = false, value = true) {
    return perform(async () => {
      await request('/notifications/read', 'POST', { ids, all, read: value });
      for (const n of S.data.notifs) if (all || ids.includes(n.id)) n.read = value;
    });
  }
  A.selNotif = el => {
    const n = S.data.notifs.find(item => item.id === el.dataset.id);
    if (!n) return;
    S.ui.inboxSel = n.id;
    void read([n.id]);
    void loadComments(n.task);
    render();
  };
  A.toggleRead = el => {
    const n = S.data.notifs.find(item => item.id === el.dataset.id);
    if (n) void read([n.id], false, !n.read);
  };
  A.markAllRead = () => {
    void read([], true);
  };
  A.openNotif = el => {
    const n = S.data.notifs.find(item => item.id === el.dataset.id);
    if (!n) return;
    void read([n.id]);
    if (n.task) A.openTask({ dataset: { id: n.task } });
  };
  A.copyLink = el => {
    const id = el.dataset.fid || el.dataset.pid || el.dataset.id;
    const kind = el.dataset.fid || S.data.files.some(file => file.id === id) ? 'file' : el.dataset.pid || proj(id) ? 'project' : 'task';
    const url = new URL('/', location.origin);
    url.searchParams.set('workspace', session.workspace.id);
    url.hash = `${kind}=${encodeURIComponent(id)}`;
    void navigator.clipboard
      .writeText(url.href)
      .then(() => toast('Link disalin.', { kind: 'info' }))
      .catch(() => toast(url.href, { kind: 'info', ms: 10000 }));
  };
  function followLink() {
    const match = location.hash.match(/^#(task|project|file)=([A-Za-z0-9_-]+)$/);
    if (!match) return;
    const [, kind, id] = match;
    if (kind === 'task' && task(id)) A.openTask({ dataset: { id } });
    else if (kind === 'project' && proj(id)) go('project', { id, tab: 'board' });
    else if (kind === 'file' && S.data.files.some(file => file.id === id)) A.previewFile({ dataset: { id } });
    else toast('Item tidak ditemukan atau Anda tidak memiliki akses.', { kind: 'err' });
  }
  window.addEventListener('hashchange', followLink);
  followLink();
}
