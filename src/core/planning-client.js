import { DateTime } from 'luxon';
import { A, IN, confirmDlg } from '../actions/actions.js';
import { S, proj, save } from './store.js';
import { iso, TODAY, uid } from './utils.js';
import { render } from '../shell/render.js';
import { openModal, closeModal } from '../overlays/modals.js';
import { toast } from '../ui/toast.js';
import { projectAllows } from './permissions.js';
import { moveEvent } from './event-time.js';
export function initPlanning({ session, sync }) {
  const writable = p => projectAllows(p, session.user.id, session.workspace.role, 'write');
  A.nativeNewMilestone = el => openModal({ type: 'nativeMilestone', project: el.dataset.project, date: iso(TODAY), name: '' });
  A.nativeEditMilestone = el => {
    const p = proj(el.dataset.project),
      index = Number(el.dataset.index);
    openModal({ type: 'nativeMilestone', project: p.id, edit: true, index, ...p.milestones[index] });
  };
  A.nativeSaveMilestone = () => {
    const m = S.ui.modals.at(-1),
      p = proj(m.project),
      name = document.getElementById('milestone-name').value.trim(),
      date = document.getElementById('milestone-date').value;
    if (!writable(p)) return;
    if (!name || !date) {
      toast('Isi nama dan tanggal milestone.', { kind: 'err' });
      return;
    }
    const milestone = { id: m.id || uid('ms'), name, date, done: document.getElementById('milestone-done').checked };
    if (m.edit) p.milestones[m.index] = milestone;
    else (p.milestones ||= []).push(milestone);
    save();
    closeModal();
    void sync.flush().catch(() => {});
  };
  A.nativeDeleteMilestone = el => {
    const p = proj(el.dataset.project),
      index = Number(el.dataset.index);
    confirmDlg({
      title: 'Hapus milestone?',
      body: 'Task dalam proyek tetap disimpan.',
      ok: 'Hapus',
      danger: true,
      run: () => {
        if (writable(p)) {
          p.milestones.splice(index, 1);
          save();
          render();
        }
      },
    });
  };
  A.nativeNewEvent = el => {
    const project = el?.dataset.project || S.ui.params.id || S.data.projects.find(writable)?.id;
    if (!writable(proj(project))) {
      toast('Pilih proyek dengan izin edit untuk membuat event.', { kind: 'info' });
      return;
    }
    openModal({
      type: 'nativeEvent',
      event: {
        id: uid('ev'),
        project,
        title: '',
        date: el?.dataset.date || S.ui.calDate || iso(TODAY),
        time: '09:00',
        timezone: S.prefs.tz,
        duration: 60,
        allDay: false,
        attendees: [session.user.id],
        description: '',
        location: '',
        link: '',
        type: 'meeting',
      },
    });
  };
  A.nativeEditEvent = el => {
    const event = S.data.events.find(e => e.id === el.dataset.id);
    if (event && writable(proj(event.project))) openModal({ type: 'nativeEvent', edit: true, event: structuredClone(event) });
  };
  const read = () => {
    const f = S.ui.modals.at(-1).event,
      v = id => document.getElementById('event-' + id)?.value;
    return {
      ...f,
      title: v('title').trim(),
      project: v('project'),
      date: v('date'),
      time: v('time'),
      timezone: v('timezone').trim(),
      duration: Number(v('duration')),
      allDay: document.getElementById('event-all-day').checked,
      attendees: [...document.querySelectorAll('[data-event-attendee]:checked')].map(el => el.dataset.eventAttendee),
      description: v('description'),
      location: v('location'),
      link: v('link'),
      type: v('type'),
    };
  };
  IN.nativeEventProject = () => {
    const f = read();
    f.attendees = f.attendees.filter(id => {
      const u = S.data.members.find(u => u.id === id);
      return u && projectAllows(proj(f.project), id, u.role.toLowerCase(), 'read');
    });
    S.ui.modals.at(-1).event = f;
    render();
  };
  A.nativeSaveEvent = () => {
    const f = read();
    if (!f.title || !f.date || !f.time || !f.timezone || f.duration < 5 || f.duration > 1440) {
      toast('Lengkapi judul, jadwal, zona waktu, dan durasi event.', { kind: 'err' });
      return;
    }
    const local = DateTime.fromISO(f.date + 'T' + (f.allDay ? '00:00' : f.time), { zone: f.timezone });
    if (!local.isValid || local.toFormat('yyyy-MM-dd HH:mm') !== f.date + ' ' + (f.allDay ? '00:00' : f.time)) {
      toast('Jadwal tidak valid di zona waktu ini.', { kind: 'err' });
      return;
    }
    if (f.link && !/^https?:\/\//.test(f.link)) {
      toast('Link meeting harus dimulai dengan https:// atau http://.', { kind: 'err' });
      return;
    }
    if (!writable(proj(f.project))) return;
    const index = S.data.events.findIndex(e => e.id === f.id);
    if (index < 0) S.data.events.push(f);
    else S.data.events[index] = f;
    save();
    closeModal();
    void sync.flush().catch(() => {});
  };
  A.nativeDeleteEvent = el => {
    const event = S.data.events.find(e => e.id === el.dataset.id);
    if (!event) return;
    confirmDlg({
      title: 'Hapus event?',
      body: event.title,
      ok: 'Hapus',
      danger: true,
      run: () => {
        if (writable(proj(event.project))) {
          S.data.events = S.data.events.filter(e => e.id !== event.id);
          save();
          render();
        }
      },
    });
  };
  let dragged;
  document.addEventListener('dragstart', e => {
    const el = e.target.closest?.('[data-drag-event]');
    if (!el) return;
    const event = S.data.events.find(e => e.id === el.dataset.dragEvent);
    if (!writable(proj(event.project))) {
      e.preventDefault();
      return;
    }
    dragged = event.id;
    e.dataTransfer.setData('text/plain', event.id);
  });
  document.addEventListener('dragover', e => {
    if (dragged && e.target.closest('[data-drop-day]')) e.preventDefault();
  });
  document.addEventListener('drop', e => {
    const day = e.target.closest('[data-drop-day]')?.dataset.dropDay;
    if (!dragged || !day) return;
    e.preventDefault();
    const index = S.data.events.findIndex(event => event.id === dragged);
    if (index >= 0) {
      S.data.events[index] = moveEvent(S.data.events[index], day, S.prefs.tz);
      save();
      render();
    }
    dragged = null;
  });
  document.addEventListener('dragend', () => {
    dragged = null;
  });
}
