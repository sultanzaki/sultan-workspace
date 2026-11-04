import { createMailer, deliverOne } from './mail.js';
import { queueEmailJobs } from './email-jobs.js';
import { runAutomations } from './automations.js';

export function createMaintenance(pool, config, { deliver = createMailer(config) } = {}) {
  let pending = null,
    followup = null,
    cleanedAt = 0;
  return function maintain({ maxMessages = config.serverless ? 100 : 20, deadline = config.serverless ? Date.now() + 45000 : Infinity } = {}) {
    if (pending) {
      // A request may create mail after the active worker's last queue read.
      // Coalesce those callers into one follow-up pass, retaining their deadline.
      const again = () => {
        followup = null;
        return maintain({ maxMessages, deadline });
      };
      followup ??= pending.then(again, again);
      return followup;
    }
    pending = (async () => {
      const reminders = await runAutomations(pool);
      let processed = 0,
        queued = 0;
      if (config.MAIL_TRANSPORT !== 'disabled') {
        queued = await queueEmailJobs(pool);
        for (let i = 0; i < maxMessages; i++) {
          if (config.serverless && Date.now() + 18000 > deadline) break;
          if (config.MAIL_TRANSPORT === 'resend' && i) await new Promise(resolve => setTimeout(resolve, 550));
          if (!(await deliverOne(pool, deliver, config))) break;
          processed++;
        }
      }
      if (Date.now() - cleanedAt > 60000) {
        await pool.query("DELETE FROM email_events WHERE created_at<now()-interval '7 days'");
        await pool.query("DELETE FROM email_digest_runs WHERE created_at<now()-interval '14 days'");
        await pool.query('DELETE FROM email_unsubscribe_tokens WHERE expires_at<now()');
        await pool.query("DELETE FROM email_webhook_events WHERE received_at<now()-interval '30 days'");
        await pool.query('DELETE FROM rate_limits WHERE expires_at < now()');
        await pool.query('DELETE FROM sessions WHERE expires_at < now()');
        await pool.query('DELETE FROM login_challenges WHERE expires_at < now()');
        await pool.query('UPDATE user_security SET pending_secret=NULL,pending_until=NULL WHERE pending_until<now()');
        await pool.query("DELETE FROM mail_outbox WHERE created_at < now() - interval '7 days'");
        await pool.query("DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'");
        cleanedAt = Date.now();
      }
      return { processed, reminders, queued };
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}
