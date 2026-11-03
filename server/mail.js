import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { transaction } from './db.js';

export async function queueMail(db, { to, subject, body, invitationId = null, resetHash = null }) {
  await db.query('INSERT INTO mail_outbox(id, recipient, subject, body, invitation_id, reset_hash) VALUES ($1,$2,$3,$4,$5,$6)', [
    randomUUID(),
    to,
    subject,
    body,
    invitationId,
    resetHash,
  ]);
}

export function createMailer(config) {
  const transport =
    config.MAIL_TRANSPORT === 'smtp'
      ? nodemailer.createTransport({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          secure: config.SMTP_SECURE === 'true',
          requireTLS: config.SMTP_SECURE !== 'true',
          connectionTimeout: 10000,
          socketTimeout: 20000,
          auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
          tls: { rejectUnauthorized: true },
        })
      : null;
  return async mail => {
    if (config.MAIL_TRANSPORT === 'disabled') throw new Error('Email delivery is disabled');
    if (transport) {
      await transport.sendMail({ from: config.MAIL_FROM, to: mail.recipient, subject: mail.subject, text: mail.body });
    } else {
      // Development delivery only; token-bearing messages never go to application logs.
      await mkdir(config.MAIL_DIRECTORY, { recursive: true, mode: 0o700 });
      await chmod(config.MAIL_DIRECTORY, 0o700);
      await writeFile(path.join(config.MAIL_DIRECTORY, `${mail.id}.json`), JSON.stringify({ to: mail.recipient, subject: mail.subject, text: mail.body }), {
        mode: 0o600,
      });
    }
  };
}

export async function deliverOne(pool, deliver) {
  return transaction(pool, async db => {
    const { rows } = await db.query(
      `SELECT * FROM mail_outbox WHERE sent_at IS NULL AND next_attempt_at <= now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    const mail = rows[0];
    if (!mail) return false;
    // Cancel undelivered messages whose one-time tokens were revoked/consumed/expired.
    const valid = mail.invitation_id
      ? await db.query('SELECT 1 FROM invitations WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > now()', [mail.invitation_id])
      : await db.query('SELECT 1 FROM password_resets WHERE token_hash=$1 AND consumed_at IS NULL AND expires_at > now()', [mail.reset_hash]);
    if (!valid.rowCount) {
      await db.query('DELETE FROM mail_outbox WHERE id=$1', [mail.id]);
      return true;
    }
    try {
      await deliver(mail);
      // Remove token-bearing content after successful delivery.
      await db.query("UPDATE mail_outbox SET sent_at=now(), body='', attempts=attempts+1 WHERE id=$1", [mail.id]);
    } catch {
      await db.query(
        "UPDATE mail_outbox SET attempts=attempts+1, next_attempt_at=now()+ least(3600, power(2, least(attempts+1,12))::integer)*interval '1 second' WHERE id=$1",
        [mail.id],
      );
      console.error('Mail delivery failed; queued for retry. Check SMTP settings.');
    }
    return true;
  });
}
