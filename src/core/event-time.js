import { DateTime } from 'luxon';
export function eventSlot(event, zone, format = '24') {
  if (event.allDay) return { date: event.date, time: '00:00', label: 'All day' };
  const date = DateTime.fromISO(event.startsAt || `${event.date}T${event.time}`, { zone: event.startsAt ? undefined : event.timezone || 'UTC' }).setZone(
    zone || 'UTC',
  );
  return { date: date.toISODate(), time: date.toFormat('HH:mm'), label: date.toFormat(format === '12' ? 'h:mm a' : 'HH:mm') };
}
export function moveEvent(event, day, zone) {
  if (event.allDay) return { ...event, date: day };
  const slot = eventSlot(event, zone),
    date = DateTime.fromISO(`${day}T${slot.time}`, { zone: zone || 'UTC' }).setZone(event.timezone);
  return { ...event, date: date.toISODate(), time: date.toFormat('HH:mm') };
}
