import { S } from '../core/store.js';
import { esc } from '../core/utils.js';
import { getWorkspaceSession } from '../core/workspace-session.js';
import { projectAllows } from '../core/permissions.js';
const field = (label, id, value = '', type = 'text', extra = '') =>
  `<div class="field"><label class="label" for="${id}">${label}</label><input class="input" id="${id}" value="${esc(value)}" type="${type}" ${extra}></div>`;
export function planningModal(m, H) {
  const footer = action =>
    `<div class="modal-f"><span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Batal</button><button class="btn btn-primary" data-a="${action}">Simpan</button></div>`;
  if (m.type === 'nativeMilestone')
    return `${H(m.edit ? 'Edit milestone' : 'Tambah milestone')}<form class="modal-b col" data-submit="nativeSaveMilestone" style="gap:12px">${field('Nama milestone', 'milestone-name', m.name, 'text', 'maxlength="200" required')}${field('Tanggal target', 'milestone-date', m.date, 'date', 'required')}<label class="row"><input type="checkbox" id="milestone-done" ${m.done ? 'checked' : ''}>Milestone selesai</label></form>${footer('nativeSaveMilestone')}`;
  const s = getWorkspaceSession(),
    f = m.event,
    projects = S.data.projects.filter(p => !p.archived && projectAllows(p, s.user.id, s.workspace.role, 'write'));
  return `${H(m.edit ? 'Edit event' : 'Buat event')}<form class="modal-b col" data-submit="nativeSaveEvent" style="gap:12px">
 ${field('Judul event', 'event-title', f.title, 'text', 'maxlength="200" required')}
 <label class="label" for="event-project">Proyek</label><select class="select" id="event-project" data-in="nativeEventProject">${projects.map(p => `<option value="${p.id}" ${p.id === f.project ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
 ${field('Tanggal', 'event-date', f.date, 'date', 'required')}${field('Jam mulai', 'event-time', f.time, 'time', 'required')}
 <label class="row"><input id="event-all-day" type="checkbox" ${f.allDay ? 'checked' : ''}>Sepanjang hari</label>
 ${field('Durasi (menit)', 'event-duration', f.duration, 'number', 'min="5" max="1440"')}${field('Zona waktu (IANA)', 'event-timezone', f.timezone, 'text', 'placeholder="Asia/Jakarta" maxlength="100"')}
 <label class="label" for="event-type">Jenis</label><select class="select" id="event-type">${[
   ['meeting', 'Meeting'],
   ['focus', 'Fokus'],
   ['other', 'Lainnya'],
 ]
   .map(([v, l]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${l}</option>`)
   .join('')}</select>
 ${field('Lokasi', 'event-location', f.location, 'text', 'maxlength="200"')}${field('Link meeting', 'event-link', f.link, 'url', 'placeholder="https://…"')}
 <label class="label" for="event-description">Deskripsi</label><textarea class="textarea" id="event-description" maxlength="5000" rows="3">${esc(f.description)}</textarea>
 <fieldset><legend>Peserta</legend>${S.data.members
   .filter(
     u =>
       u.status === 'active' &&
       projectAllows(
         projects.find(p => p.id === f.project),
         u.id,
         u.role.toLowerCase(),
         'read',
       ),
   )
   .map(
     u =>
       `<label class="row" style="padding:4px"><input type="checkbox" data-event-attendee="${u.id}" ${f.attendees.includes(u.id) ? 'checked' : ''}>${esc(u.name)}</label>`,
   )
   .join('')}</fieldset>
 </form>${footer('nativeSaveEvent')}`;
}
