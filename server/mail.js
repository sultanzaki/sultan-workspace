import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { transaction } from './db.js';
import { canDeliver, renderQueuedEmail } from './email-content.js';

export async function queueMail(
  db,
  {
    to,
    subject,
    body,
    invitationId = null,
    resetHash = null,
    kind = invitationId ? 'invitation' : resetHash ? 'reset' : 'security',
    workspaceId = null,
    userId = null,
    context = {},
    dedupeKey = null,
  },
) {
  await db.query(
    `INSERT INTO mail_outbox(id,recipient,subject,body,invitation_id,reset_hash,kind,workspace_id,user_id,context,dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(dedupe_key) DO NOTHING`,
    [randomUUID(), to, subject.replace(/[\r\n]/g, ' '), body, invitationId, resetHash, kind, workspaceId, userId, context, dedupeKey],
  );
}
export async function queueSecurityMail(db, config, userId, message) {
  if (config.MAIL_TRANSPORT === 'disabled') return;
  const user = (await db.query('SELECT email,name FROM users WHERE id=$1 AND disabled_at IS NULL', [userId])).rows[0];
  if (!user) return;
  await queueMail(db, {
    to: user.email,
    userId,
    kind: 'security',
    subject: 'Account security notification',
    body: `Hello ${user.name},\n\n${message}\nTime: ${new Date().toISOString()}\n\nIf this was not you, secure your account by changing your password immediately. Two-factor authentication is still required when enabled.\n${config.APP_ORIGIN}/`,
  });
}
export function createMailer(config, { fetchImpl = globalThis.fetch } = {}) {
  const transport =
    config.MAIL_TRANSPORT === 'smtp'
      ? nodemailer.createTransport({
          host: config.SMTP_HOST,
          port: config.SMTP_PORT,
          secure: config.SMTP_SECURE === 'true',
          requireTLS: config.SMTP_SECURE !== 'true',
          connectionTimeout: 8000,
          socketTimeout: 10000,
          auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
          tls: { rejectUnauthorized: true },
        })
      : null;
  return async mail => {
    if (config.MAIL_TRANSPORT === 'disabled') throw new Error('Email delivery is disabled');
    if (config.MAIL_TRANSPORT === 'resend') {
      let response;
      try {
        response = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          signal: AbortSignal.timeout(8000),
          headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'sultan-mail/' + mail.id },
          body: JSON.stringify({
            from: mail.context?.sender || config.MAIL_FROM,
            to: [mail.recipient],
            subject: mail.subject,
            text: mail.body,
            html: mail.html,
            headers: mail.headers,
            tags: [
              { name: 'app', value: 'sultan-workspace' },
              { name: 'outbox', value: mail.id },
            ],
          }),
        });
      } catch {
        throw Object.assign(new Error('Email provider unavailable'), { code: 'network_timeout' });
      }
      if (!response.ok) {
        const status = response.status;
        throw Object.assign(new Error('Email provider rejected request'), {
          code: status === 429 ? 'rate_limited' : [401, 403].includes(status) ? 'provider_auth' : status >= 500 ? 'provider_unavailable' : 'provider_rejected',
          permanent: [400, 404, 422].includes(status),
        });
      }
      const data = await response.json();
      if (typeof data.id !== 'string' || data.id.length > 100) throw new Error('Invalid email provider response');
      return { id: data.id };
    }
    if (transport) {
      try {
        const result = await transport.sendMail({
          from: mail.context?.sender || config.MAIL_FROM,
          to: mail.recipient,
          subject: mail.subject,
          text: mail.body,
          html: mail.html,
          headers: mail.headers,
        });
        return { id: result.messageId };
      } catch (error) {
        throw Object.assign(new Error('SMTP delivery failed'), { code: 'smtp_failed', permanent: error.responseCode >= 550 && error.responseCode < 560 });
      }
    }
    await mkdir(config.MAIL_DIRECTORY, { recursive: true, mode: 0o700 });
    await chmod(config.MAIL_DIRECTORY, 0o700);
    await writeFile(
      path.join(config.MAIL_DIRECTORY, `${mail.id}.json`),
      JSON.stringify({ to: mail.recipient, subject: mail.subject, text: mail.body, html: mail.html, headers: mail.headers }),
      { mode: 0o600 },
    );
    return { id: 'file:' + mail.id };
  };
}
const clearContent = "body='',html='',headers='{}',context='{}',claim_token=NULL,locked_until=NULL";
export async function deliverOne(pool, deliver, config = { APP_ORIGIN: 'http://localhost:5173' }) {
  // Commit the rendered envelope before calling the provider. A lost response or
  // DB commit must retry the identical payload with the same Resend idempotency key.
  const claim = await transaction(pool, async db => {
    const candidate = (
      await db.query(
        "SELECT id,workspace_id FROM mail_outbox WHERE finished_at IS NULL AND next_attempt_at<=now() AND (locked_until IS NULL OR locked_until<now()) ORDER BY CASE WHEN kind IN ('invitation','reset','security') THEN 0 ELSE 1 END,created_at,id LIMIT 1",
      )
    ).rows[0];
    if (!candidate) return null;
    if (candidate.workspace_id) await db.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [candidate.workspace_id]);
    const mail = (
      await db.query(
        `SELECT * FROM mail_outbox WHERE id=$1 AND finished_at IS NULL AND next_attempt_at<=now() AND (locked_until IS NULL OR locked_until<now()) FOR UPDATE SKIP LOCKED`,
        [candidate.id],
      )
    ).rows[0];
    if (!mail) return null;
    const kind = mail.reset_hash ? 'reset' : mail.invitation_id ? 'invitation' : mail.kind;
    if (kind !== mail.kind) {
      await db.query('UPDATE mail_outbox SET kind=$2 WHERE id=$1', [mail.id, kind]);
      mail.kind = kind;
    }
    if (new Date(mail.expires_at) <= new Date() || mail.attempts >= 8) {
      await db.query(`UPDATE mail_outbox SET finished_at=now(),delivery_status='failed',error_code='expired',${clearContent} WHERE id=$1`, [mail.id]);
      return { finished: true };
    }
    if (!(await canDeliver(db, mail))) {
      await db.query(`UPDATE mail_outbox SET finished_at=now(),delivery_status='cancelled',${clearContent} WHERE id=$1`, [mail.id]);
      return { finished: true };
    }
    if (!mail.rendered_at) {
      const content = await renderQueuedEmail(db, mail, config);
      if (!content) {
        await db.query(`UPDATE mail_outbox SET finished_at=now(),delivery_status='cancelled',${clearContent} WHERE id=$1`, [mail.id]);
        return { finished: true };
      }
      await db.query(
        "UPDATE mail_outbox SET recipient=$2,subject=$3,body=$4,html=$5,headers=$6,context=$7,rendered_at=now(),expires_at=least(expires_at,now()+interval '23 hours') WHERE id=$1",
        [mail.id, content.recipient, content.subject, content.body, content.html, content.headers, { ...content.context, sender: config.MAIL_FROM }],
      );
    }
    const claimToken = randomUUID();
    await db.query("UPDATE mail_outbox SET claim_token=$2,locked_until=now()+interval '45 seconds' WHERE id=$1", [mail.id, claimToken]);
    return { id: mail.id, token: claimToken, workspace: mail.workspace_id };
  });
  if (!claim) return false;
  if (claim.finished) return true;
  await transaction(pool, async db => {
    // Grant changes use the workspace update lock. Keep a share lock while
    // checking access and delivering so a revoked recipient cannot receive content.
    if (claim.workspace) await db.query('SELECT id FROM workspaces WHERE id=$1 FOR SHARE', [claim.workspace]);
    const mail = (
      await db.query('SELECT * FROM mail_outbox WHERE id=$1 AND claim_token=$2 AND finished_at IS NULL FOR UPDATE SKIP LOCKED', [claim.id, claim.token])
    ).rows[0];
    if (!mail) return;
    if (!(await canDeliver(db, mail))) {
      await db.query(`UPDATE mail_outbox SET finished_at=now(),delivery_status='cancelled',${clearContent} WHERE id=$1`, [mail.id]);
      return;
    }
    try {
      const result = await deliver(mail);
      await db.query(
        `UPDATE mail_outbox SET sent_at=now(),finished_at=now(),delivery_status='accepted',provider_id=$2,error_code=NULL,attempts=attempts+1,${clearContent} WHERE id=$1`,
        [mail.id, result?.id || null],
      );
    } catch (error) {
      const permanent = error.permanent || mail.attempts >= 7,
        code = ['network_timeout', 'rate_limited', 'provider_auth', 'provider_unavailable', 'provider_rejected', 'smtp_failed'].includes(error.code)
          ? error.code
          : 'delivery_failed';
      if (permanent)
        await db.query(`UPDATE mail_outbox SET finished_at=now(),delivery_status='failed',error_code=$2,attempts=attempts+1,${clearContent} WHERE id=$1`, [
          mail.id,
          code,
        ]);
      else
        await db.query(
          "UPDATE mail_outbox SET error_code=$2,attempts=attempts+1,claim_token=NULL,locked_until=NULL,next_attempt_at=now()+least(3600,power(2,least(attempts+5,12))::integer)*interval '1 second' WHERE id=$1",
          [mail.id, code],
        );
      console.error('Mail delivery failed; queued or marked failed. Check email delivery status.');
    }
  });
  return true;
}
