import { A, IN, DBL, BLUR, KEY } from '../actions/actions.js';
import { S, proj, task } from './store.js';
import { projectAllows } from './permissions.js';
import { toast } from '../ui/toast.js';
export function initPermissions({ session }) {
  const manager = () => ['owner', 'admin'].includes(session.workspace.role);
  const can = (p, action = 'write') => projectAllows(p, session.user.id, session.workspace.role, action);
  session.canProject = can;
  function projectFor(el) {
    const d = el?.dataset || {},
      modal = S.ui.modals.at(-1),
      pop = S.ui.pop;
    const id = d.id || d.dragCard || d.dragRow || d.dragCal || d.dragEvent || d.bar || d.taskRow || d.blurId;
    const comment = S.data.comments.find(c => c.id === id),
      file = S.data.files.find(f => f.id === id),
      event = S.data.events.find(e => e.id === id);
    const p = d.project || task(id)?.project || event?.project || file?.project || task(comment?.task)?.project || (proj(id) ? id : null);
    if (p) return proj(p);
    if (modal?.type === 'project') return modal.edit ? proj(modal.edit) : null;
    if (pop?.id && pop.id !== '__form') return proj(task(pop.id)?.project || (proj(pop.id) ? pop.id : null));
    if (modal?.type === 'task') return proj(S.ui.form.project);
    if (modal?.project) return proj(modal.project);
    if (modal?.event) return proj(modal.event.project);
    if (S.ui.drawer) return proj(task(S.ui.drawer)?.project);
    if (S.ui.route === 'project') return proj(S.ui.params.id);
    return null;
  }
  const writes = new Set(
    'promoteSub ctxStatus ctxAssign ctxPrio ctxMove toggleDone dupTask archiveTask delTask editTask submitTask commitComposer rmSub toggleSub rmAttach renameFile dupFile delFile nativeDeleteFile nativeRenameFile nativeSaveFileName popToggleLabel popToggleDep bulkSet bulkDelete colDoneAll colArchive colSortPrio saveViewSubmit renameView delView nativeNewMilestone nativeEditMilestone nativeDeleteMilestone nativeSaveMilestone nativeEditEvent nativeSaveEvent nativeDeleteEvent'.split(
      ' ',
    ),
  );
  const manage = new Set(
    'editProject submitProject archiveProject restoreProject delProject nativeProjectPrivate nativeProjectMember nativeProjectPermission'.split(' '),
  );
  const comments = new Set('postComment delComment react nativeEditComment nativeSaveComment nativeDeleteComment pickMention insertAt draft'.split(' '));
  const edits = new Set('status priority assignee project recur estimate date labels dependencies subassignee pstatus'.split(' '));
  const inputs = new Set('form formFiles uploadFiles nativeUploadFiles nativeFileUpload subNote drawerTitle drawerDesc subTitle subDue subAssignee'.split(' '));
  function allowed(name, el, kind = 'action') {
    if (el?.disabled) return false;
    if (
      [
        'newTeam',
        'nativeNewTeam',
        'editTeam',
        'nativeEditTeam',
        'nativeSaveTeam',
        'delTeam',
        'nativeDeleteTeam',
        'nativeSaveWorkspace',
        'nativeMemberRole',
        'nativeMemberToggle',
        'nativeWorkspacePolicy',
      ].includes(name)
    )
      return manager();
    if (['invite', 'nativeInvite'].includes(name)) return manager() || (S.data.ws.settings.leadCanInviteGuests && can(proj(el?.dataset.project), 'manage'));
    if (name === 'newProject' || name === 'dupProject')
      return session.workspace.role !== 'guest' && (manager() || S.data.ws.settings.membersCanCreateProjects !== false);
    if (name === 'newTask' && !S.data.projects.length)
      return session.workspace.role !== 'guest' && (manager() || S.data.ws.settings.membersCanCreateProjects !== false);
    if (name === 'newTask' || name === 'startComposer' || name === 'nativeNewEvent') {
      const p = projectFor(el);
      return p ? can(p) : S.data.projects.some(p => !p.archived && can(p));
    }
    let level = manage.has(name) ? 'manage' : writes.has(name) || inputs.has(name) ? 'write' : comments.has(name) ? 'comment' : null;
    if (name === 'pop' && edits.has(el.dataset.pop)) level = el.dataset.pop === 'pstatus' ? 'manage' : 'write';
    if (name === 'popPick' && edits.has(S.ui.pop?.type)) level = S.ui.pop.type === 'pstatus' ? 'manage' : 'write';
    if (['nativeProjectPrivate', 'nativeProjectMember', 'nativeProjectPermission', 'pform', 'pformPrivate', 'pformSet'].includes(name)) level = 'manage';
    if (kind === 'edit') level = 'write';
    if (!level) return true;
    if (['bulkSet', 'bulkDelete'].includes(name)) return [...S.ui.sel].every(id => can(proj(task(id)?.project), level));
    const p = projectFor(el);
    if (!p && S.ui.modals.at(-1)?.type === 'project' && !S.ui.modals.at(-1).edit)
      return session.workspace.role !== 'guest' && (manager() || S.data.ws.settings.membersCanCreateProjects !== false);
    return p ? can(p, level) : false;
  }
  for (const [handlers, kind] of [
    [A, 'action'],
    [IN, 'input'],
    [DBL, 'edit'],
    [BLUR, 'edit'],
    [KEY, 'edit'],
  ]) {
    for (const [name, handler] of Object.entries(handlers)) {
      if (kind === 'edit' && !/commit|edit|sub|desc/i.test(name)) continue;
      handlers[name] = (el, event) => {
        if (!allowed(name, el, kind)) {
          event?.preventDefault?.();
          toast('Akses Anda belum mengizinkan perubahan ini. Minta izin kepada lead proyek.', { kind: 'info' });
          return;
        }
        return handler(el, event);
      };
    }
  }
  const previous = session.onRender;
  session.onRender = () => {
    previous?.();
    document.querySelectorAll('[data-a],[data-in],[data-dbl],[data-blur],[draggable=true],[contenteditable=true]').forEach(el => {
      const name = el.dataset.a || el.dataset.in || el.dataset.dbl || el.dataset.blur;
      const editing = !!(el.dataset.dbl || el.dataset.blur);
      if (
        (name && !allowed(name, el, editing ? 'edit' : 'action')) ||
        (el.draggable && task(el.dataset.dragCard || el.dataset.dragRow || el.dataset.dragCal) && !can(projectFor(el)))
      ) {
        if (el.matches('button,input,select,textarea')) el.disabled = true;
        else if (editing) {
          el.removeAttribute('data-dbl');
          el.removeAttribute('data-blur');
        }
        if (el.isContentEditable) el.contentEditable = 'false';
        el.draggable = false;
      }
    });
    const drawer = task(S.ui.drawer);
    if (drawer && !can(proj(drawer.project))) {
      document
        .querySelectorAll('.drawer [contenteditable=true],.drawer [data-blur],.drawer [data-in],.drawer [data-key-enter],.drawer [data-cmd]')
        .forEach(el => {
          if (el.closest('.cbox') && can(proj(drawer.project), 'comment')) return;
          if (el.matches('input,textarea')) el.readOnly = true;
          if (el.matches('button')) el.disabled = true;
          el.removeAttribute('contenteditable');
        });
    }
  };
  document.addEventListener(
    'dragstart',
    e => {
      const el = e.target.closest?.('[draggable]');
      if (!el) return;
      const p = projectFor(el);
      if (p && !can(p)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    e => {
      const el = e.target.closest?.('[data-bar]');
      if (el && !can(projectFor(el))) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
}
