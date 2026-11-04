import { S } from '../core/store.js';
import { esc } from '../core/utils.js';
import { getWorkspaceSession } from '../core/workspace-session.js';
import { projectAllows } from '../core/permissions.js';
const field = (label, id, value = '', type = 'text', extra = '') =>
  `<div class="field"><label class="label" for="${id}">${label}</label><input class="input" id="${id}" value="${esc(value)}" type="${type}" ${extra}></div>`;
export function planningModal(m, H) {
  const footer = action =>
    `<div class="modal-f"><span class="sp"></span><button class="btn btn-secondary" data-a="closeModal">Cancel</button><button class="btn btn-primary" data-a="${action}">Save</button></div>`;
  if (m.type === 'nativeMilestone')
    return `${H(m.edit ? 'Edit milestone' : 'Add milestone')}<form class="modal-b col" data-submit="nativeSaveMilestone" style="gap:12px">${field('Milestone name', 'milestone-name', m.name, 'text', 'maxlength="200" required')}${field('Target date', 'milestone-date', m.date, 'date', 'required')}<label class="row"><input type="checkbox" id="milestone-done" ${m.done ? 'checked' : ''}>Milestone completed</label></form>${footer('nativeSaveMilestone')}`;
  const s = getWorkspaceSession(),
    f = m.event,
    projects = S.data.projects.filter(p => !p.archived && projectAllows(p, s.user.id, s.workspace.role, 'write'));
  return `${H(m.edit ? 'Edit event' : 'Create event')}<form class="modal-b col" data-submit="nativeSaveEvent" style="gap:12px">
 ${field('Event title', 'event-title', f.title, 'text', 'maxlength="200" required')}
 <label class="label" for="event-project">Project</label><select class="select" id="event-project" data-in="nativeEventProject">${projects.map(p => `<option value="${p.id}" ${p.id === f.project ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
 ${field('Date', 'event-date', f.date, 'date', 'required')}${field('Start time', 'event-time', f.time, 'time', 'required')}
 <label class="row"><input id="event-all-day" type="checkbox" ${f.allDay ? 'checked' : ''}>All day</label>
 ${field('Duration (minutes)', 'event-duration', f.duration, 'number', 'min="5" max="1440"')}${field('Time zone (IANA)', 'event-timezone', f.timezone, 'text', 'placeholder="Asia/Jakarta" maxlength="100"')}
 <label class="label" for="event-type">Type</label><select class="select" id="event-type">${[
   ['meeting', 'Meeting'],
   ['focus', 'Focus'],
   ['other', 'Other'],
 ]
   .map(([v, l]) => `<option value="${v}" ${f.type === v ? 'selected' : ''}>${l}</option>`)
   .join('')}</select>
 ${field('Location', 'event-location', f.location, 'text', 'maxlength="200"')}${field('Meeting link', 'event-link', f.link, 'url', 'placeholder="https://…"')}
 <label class="label" for="event-description">Description</label><textarea class="textarea" id="event-description" maxlength="5000" rows="3">${esc(f.description)}</textarea>
 <fieldset><legend>Attendees</legend>${S.data.members
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
