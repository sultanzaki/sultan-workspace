import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { transaction } from './db.js';
import { digest, fail, limit, membership, tokenSchema } from './security.js';
import { EMAIL_DEFAULTS } from '../src/core/email-preferences.js';
export function verifyResendSignature(body, headers, secret, now = Date.now()) {
  const id = headers['svix-id'],
    timestamp = headers['svix-timestamp'],
    signatures = headers['svix-signature'];
  if (!id || id.length > 200 || !/^\d+$/.test(timestamp || '') || Math.abs(now / 1000 - Number(timestamp)) > 300 || typeof signatures !== 'string' || !secret)
    return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  if (key.length < 16) return false;
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest();
  return signatures.split(' ').some(value => {
    const [version, encoded] = value.split(',');
    const bytes = Buffer.from(encoded || '', 'base64');
    return version === 'v1' && bytes.length === expected.length && timingSafeEqual(bytes, expected);
  });
}
export function resendWebhook(pool, config) {
  return async (req, res) => {
    if (!config.RESEND_WEBHOOK_SECRET) fail(404, 'Webhook belum diaktifkan.');
    if (!Buffer.isBuffer(req.body) || !verifyResendSignature(req.body, req.headers, config.RESEND_WEBHOOK_SECRET))
      fail(401, 'Tanda tangan webhook tidak valid.');
    let event;
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch {
      fail(400, 'Payload tidak valid.');
    }
    const states = {
      'email.delivered': 'delivered',
      'email.bounced': 'bounced',
      'email.complained': 'complained',
      'email.failed': 'failed',
      'email.delivery_delayed': 'delayed',
    };
    const status = states[event.type];
    if (!status || typeof event.data?.email_id !== 'string') return res.json({ ok: true });
    const pending = await transaction(pool, async db => {
      const mail = (await db.query('SELECT id,recipient,delivery_status FROM mail_outbox WHERE provider_id=$1 FOR UPDATE', [event.data.email_id])).rows[0];
      if (!mail)
        return (await db.query('SELECT 1 FROM mail_outbox WHERE claim_token IS NOT NULL AND locked_until>now() AND finished_at IS NULL LIMIT 1')).rowCount > 0;
      const inserted = await db.query('INSERT INTO email_webhook_events(id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id', [req.headers['svix-id']]);
      if (!inserted.rowCount) return;
      const rank = { queued: 0, accepted: 1, delayed: 2, delivered: 3, cancelled: 4, failed: 4, bounced: 5, complained: 6 };
      if ((rank[status] || 0) > (rank[mail.delivery_status] || 0))
        await db.query('UPDATE mail_outbox SET delivery_status=$2,error_code=$3 WHERE id=$1', [
          mail.id,
          status,
          ['bounced', 'complained', 'failed'].includes(status) ? status : null,
        ]);
      if (['bounced', 'complained'].includes(status))
        await db.query('INSERT INTO email_suppressions(recipient,reason) VALUES ($1,$2) ON CONFLICT(recipient) DO UPDATE SET reason=EXCLUDED.reason', [
          mail.recipient,
          status,
        ]);
    });
    if (pending) return res.status(503).json({ error: 'Pengiriman sedang dicatat. Ulangi webhook.' });
    res.json({ ok: true });
  };
}
export function registerEmailRoutes(app, pool, { authenticated }) {
  async function unsubscribe(db, raw, update = false) {
    const row = (
      await db.query(
        'SELECT t.workspace_id,t.user_id,w.name FROM email_unsubscribe_tokens t JOIN workspaces w ON w.id=t.workspace_id WHERE token_hash=$1 AND expires_at>now()',
        [digest(raw)],
      )
    ).rows[0];
    if (!row) fail(400, 'Link pengaturan email sudah tidak berlaku. Login untuk mengubah preferensi email.');
    if (update) {
      await db.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [row.workspace_id]);
      const keys = Object.fromEntries(Object.keys(EMAIL_DEFAULTS).map(key => [key, false]));
      await db.query(
        `INSERT INTO workspace_preferences(workspace_id,user_id,data) VALUES ($1,$2,jsonb_build_object('notifPrefs',$3::jsonb)) ON CONFLICT(workspace_id,user_id) DO UPDATE SET data=jsonb_set(workspace_preferences.data,'{notifPrefs}',coalesce(workspace_preferences.data->'notifPrefs','{}')||$3::jsonb)`,
        [row.workspace_id, row.user_id, JSON.stringify(keys)],
      );
    }
    return row;
  }
  app.post('/api/email/unsubscribe/inspect', async (req, res) => {
    const { token } = z.object({ token: tokenSchema }).strict().parse(req.body);
    await limit(pool, `unsubscribe-inspect:${req.ip}`, 60, 900);
    const row = await unsubscribe(pool, token);
    res.json({ workspace: row.name });
  });
  app.post('/api/email/unsubscribe', async (req, res) => {
    const { token } = z.object({ token: tokenSchema }).strict().parse(req.body);
    await limit(pool, `unsubscribe:${req.ip}`, 30, 900);
    await transaction(pool, db => unsubscribe(db, token, true));
    res.json({ message: 'Email aktivitas workspace ini dinonaktifkan. Email keamanan dan undangan tetap tersedia.' });
  });
  app.post('/api/workspaces/:ws/mail/:id/retry', authenticated, async (req, res) => {
    await limit(pool, `retry-mail:${req.session.user_id}`, 20, 900);
    await transaction(pool, async db => {
      await membership(db, req.params.ws, req.session.user_id, ['owner', 'admin'], true);
      const id = z.string().uuid().parse(req.params.id);
      const row = (
        await db.query(
          'UPDATE mail_outbox SET next_attempt_at=now() WHERE id=$1 AND workspace_id=$2 AND finished_at IS NULL AND expires_at>now() RETURNING id',
          [id, req.params.ws],
        )
      ).rows[0];
      if (!row) fail(409, 'Pesan tidak dapat dicoba ulang. Buat undangan atau permintaan reset baru jika diperlukan.');
    });
    res.json({ message: 'Pesan dijadwalkan untuk dicoba kembali.' });
  });
}
