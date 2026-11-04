import { z } from 'zod';
import { DateTime } from 'luxon';
import { fail } from './security.js';
export const eventSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  project: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  title: z.string().trim().min(1).max(200),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().max(100),
  duration: z.number().int().min(5).max(1440),
  allDay: z.boolean().default(false),
  attendees: z.array(z.string().uuid()).max(200).default([]),
  description: z.string().max(5000).default(''),
  location: z.string().max(200).default(''),
  link: z
    .union([
      z.literal(''),
      z
        .string()
        .url()
        .refine(value => /^https?:\/\//.test(value)),
    ])
    .default(''),
  type: z.enum(['meeting', 'focus', 'other']).default('meeting'),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  by: z.string().uuid().optional(),
  created: z.number().optional(),
  updated: z.number().optional(),
});
export function normalizeEvent(value, before, user) {
  if (!DateTime.now().setZone(value.timezone).isValid) fail(400, 'Invalid event time zone.');
  const time = value.allDay ? '00:00' : value.time;
  let date = DateTime.fromISO(`${value.date}T${time}`, { zone: value.timezone });
  if (!date.isValid || date.toFormat('yyyy-MM-dd HH:mm') !== `${value.date} ${time}`) fail(400, 'Invalid event date or time in this time zone.');
  if (!value.allDay && before?.date === value.date && before.time === time && before.timezone === value.timezone && before.startsAt)
    date = DateTime.fromISO(before.startsAt, { zone: value.timezone });
  else if (!value.allDay) date = date.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis())[0];
  return {
    ...value,
    time,
    startsAt: date.toUTC().toISO(),
    endsAt: (value.allDay ? date.plus({ days: 1 }) : date.plus({ minutes: value.duration })).toUTC().toISO(),
    by: before?.by || user,
    created: before?.created || Date.now(),
    updated: Date.now(),
  };
}
