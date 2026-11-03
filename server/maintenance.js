import { createMailer, deliverOne } from './mail.js';
import { runAutomations } from './automations.js';

export function createMaintenance(pool, config) {
  const deliver = createMailer(config);
  let pending = null,
    cleanedAt = 0;
  return function maintain({ maxMessages = config.serverless ? 1 : 20 } = {}) {
    if (pending) return pending;
    pending = (async () => {
      let processed = 0;
      if (config.MAIL_TRANSPORT !== 'disabled') {
        for (let i = 0; i < maxMessages; i++) {
          if (!(await deliverOne(pool, deliver))) break;
          processed++;
        }
      }
      if (Date.now() - cleanedAt > 60000) {
        await pool.query('DELETE FROM rate_limits WHERE expires_at < now()');
        await pool.query('DELETE FROM sessions WHERE expires_at < now()');
        await pool.query('DELETE FROM login_challenges WHERE expires_at < now()');
        await pool.query('UPDATE user_security SET pending_secret=NULL,pending_until=NULL WHERE pending_until<now()');
        await pool.query("DELETE FROM mail_outbox WHERE created_at < now() - interval '7 days'");
        await pool.query("DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'");
        cleanedAt = Date.now();
      }
      const reminders = await runAutomations(pool);
      return { processed, reminders };
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}
