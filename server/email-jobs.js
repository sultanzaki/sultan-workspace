import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { transaction } from './db.js';
import { queueMail } from './mail.js';
import { emailPreference } from '../src/core/email-preferences.js';
import { projectAllows } from '../src/core/permissions.js';
export async function queueEmailJobs(pool, { now = new Date(), limit = 100 } = {}) {
  // All instances share a single short queue-building lock; network delivery is separate.
  return transaction(pool, async db => {
    if (!(await db.query('SELECT pg_try_advisory_xact_lock(1177832,7) AS locked')).rows[0].locked) return 0;
    const events = (
      await db.query(
        `SELECT e.*,u.email,u.disabled_at,m.active,m.role,p.data AS project,prefs.data AS preferences FROM email_events e JOIN users u ON u.id=e.recipient_id JOIN memberships m ON m.workspace_id=e.workspace_id AND m.user_id=e.recipient_id JOIN projects p ON p.workspace_id=e.workspace_id AND p.id=e.project_id LEFT JOIN workspace_preferences prefs ON prefs.workspace_id=e.workspace_id AND prefs.user_id=e.recipient_id WHERE e.processed_at IS NULL ORDER BY e.created_at,e.id LIMIT $1`,
        [limit],
      )
    ).rows;
    let queued = 0;
    const jobs = [];
    for (const e of events) {
      if (
        e.active &&
        !e.disabled_at &&
        projectAllows(e.project, e.recipient_id, e.role, 'read') &&
        emailPreference(e.preferences, 'email_' + e.category) &&
        new Date(e.created_at) > new Date(now.getTime() - 86400000)
      ) {
        jobs.push({
          id: randomUUID(),
          recipient: e.email,
          subject: 'Pembaruan workspace',
          body: '',
          kind: 'notification',
          workspace_id: e.workspace_id,
          user_id: e.recipient_id,
          context: { events: [e.id] },
          dedupe_key: 'notification:' + e.id,
        });
      }
    }
    if (jobs.length)
      queued += (
        await db.query(
          `INSERT INTO mail_outbox(id,recipient,subject,body,kind,workspace_id,user_id,context,dedupe_key)
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS m(id uuid,recipient text,subject text,body text,kind text,workspace_id uuid,user_id uuid,context jsonb,dedupe_key text) ON CONFLICT(dedupe_key) DO NOTHING`,
          [JSON.stringify(jobs)],
        )
      ).rowCount;
    if (events.length) await db.query('UPDATE email_events SET processed_at=now() WHERE id=ANY($1::uuid[])', [events.map(e => e.id)]);
    // A fixed 00:15 UTC slot works with the daily Vercel Hobby cron. Weekdays
    // are evaluated in the recipient's timezone at this slot, not at request time.
    const utc = DateTime.fromJSDate(now, { zone: 'UTC' }),
      slot = utc.startOf('day').plus({ minutes: 15 }),
      end = (utc < slot ? slot.minus({ days: 1 }) : slot).toJSDate();
    const recipients = (
      await db.query(
        `SELECT prefs.workspace_id,prefs.user_id,prefs.data,u.email FROM workspace_preferences prefs JOIN memberships m ON m.workspace_id=prefs.workspace_id AND m.user_id=prefs.user_id AND m.active JOIN users u ON u.id=prefs.user_id AND u.disabled_at IS NULL WHERE prefs.data#>>'{notifPrefs,email_digest}'='true' AND NOT EXISTS(SELECT 1 FROM email_digest_runs r WHERE r.workspace_id=prefs.workspace_id AND r.user_id=prefs.user_id AND r.period_end=$1) ORDER BY prefs.workspace_id,prefs.user_id LIMIT $2`,
        [end, Math.min(limit, 25)],
      )
    ).rows;
    for (const person of recipients) {
      let local = DateTime.fromJSDate(end).setZone(person.data?.prefs?.tz || 'UTC');
      if (!local.isValid) local = DateTime.fromJSDate(end, { zone: 'UTC' });
      // Record the slot even on weekends so one timezone cannot starve the batch.
      const previous = (
        await db.query('SELECT max(period_end) AS end FROM email_digest_runs WHERE workspace_id=$1 AND user_id=$2 AND weekday', [
          person.workspace_id,
          person.user_id,
        ])
      ).rows[0].end;
      await db.query('INSERT INTO email_digest_runs(workspace_id,user_id,period_end,weekday) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [
        person.workspace_id,
        person.user_id,
        end,
        local.weekday <= 5,
      ]);
      if (local.weekday > 5) continue;
      const start = previous ? new Date(Math.max(+new Date(previous), end.getTime() - 7 * 86400000)) : new Date(end.getTime() - 86400000);
      const ids = (
        await db.query(
          'SELECT id FROM email_events WHERE workspace_id=$1 AND recipient_id=$2 AND created_at>$3 AND created_at<=$4 ORDER BY created_at DESC,id LIMIT 50',
          [person.workspace_id, person.user_id, start, end],
        )
      ).rows.map(r => r.id);
      if (!ids.length) continue;
      await queueMail(db, {
        to: person.email,
        kind: 'digest',
        subject: 'Ringkasan harian',
        body: '',
        workspaceId: person.workspace_id,
        userId: person.user_id,
        context: { events: ids, periodEnd: end.toISOString() },
        dedupeKey: `digest:${person.workspace_id}:${person.user_id}:${end.toISOString()}`,
      });
      queued++;
    }
    return queued;
  });
}
