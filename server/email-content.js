import { emailPreference } from '../src/core/email-preferences.js';
import { projectAllows } from '../src/core/permissions.js';
import { token, digest } from './security.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const workspaceLink = (config, ws, task) =>
  `${config.APP_ORIGIN}/?workspace=${encodeURIComponent(ws)}${task ? '#task=' + encodeURIComponent(task) : ''}`;
export function emailLayout({ heading, paragraphs = [], items = [], action, footer = '' }) {
  return `<!doctype html><html lang="en"><body style="margin:0;background:#f5f5f7;color:#242430;font-family:Arial,sans-serif"><main style="max-width:600px;margin:24px auto;background:#fff;padding:28px;border-radius:12px"><p style="color:#4b5bd6;font-weight:bold">Sultan Workspace</p><h1 style="font-size:22px">${esc(heading)}</h1>${paragraphs.map(p => `<p style="line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere">${esc(p)}</p>`).join('')}${items.map(i => `<section style="border-top:1px solid #ddd;padding:16px 0"><h2 style="font-size:16px"><a href="${esc(i.url)}">${esc(i.title)}</a></h2><p>${esc(i.detail)}</p>${i.snippet ? `<blockquote style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(i.snippet)}</blockquote>` : ''}</section>`).join('')}${action ? `<p><a href="${esc(action.url)}" style="display:inline-block;background:#4b5bd6;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none">${esc(action.label)}</a></p>` : ''}<footer style="margin-top:24px;font-size:12px;color:#666">${footer}</footer></main></body></html>`;
}
export async function activityContext(db, mail) {
  const person = (
    await db.query(
      `SELECT u.id,u.name,u.email,w.name AS workspace,m.role,p.data AS preferences FROM users u JOIN memberships m ON m.user_id=u.id AND m.workspace_id=$2 AND m.active JOIN workspaces w ON w.id=m.workspace_id LEFT JOIN workspace_preferences p ON p.user_id=u.id AND p.workspace_id=m.workspace_id WHERE u.id=$1 AND u.disabled_at IS NULL`,
      [mail.user_id, mail.workspace_id],
    )
  ).rows[0];
  if (!person || (mail.rendered_at && mail.recipient !== person.email)) return null;
  if (mail.kind === 'digest' && !emailPreference(person.preferences, 'email_digest')) return null;
  const ids = mail.context.events || [];
  const rows = (
    await db.query(
      `SELECT e.*,p.data AS project,t.data AS task,u.name AS actor,c.body AS comment_body,c.mentions FROM email_events e JOIN projects p ON p.workspace_id=e.workspace_id AND p.id=e.project_id JOIN tasks t ON t.workspace_id=e.workspace_id AND t.id=e.task_id LEFT JOIN users u ON u.id=e.actor_id LEFT JOIN task_comments c ON c.id=e.comment_id WHERE e.id=ANY($1::uuid[]) AND e.workspace_id=$2 AND e.recipient_id=$3 ORDER BY e.created_at,e.id`,
      [ids, mail.workspace_id, mail.user_id],
    )
  ).rows;
  const events = rows.filter(
    e =>
      projectAllows(e.project, person.id, person.role, 'read') &&
      !e.project.archived &&
      !e.task.archived &&
      (e.category !== 'due' || (e.task.status !== 'done' && e.event_key.startsWith('deadline:' + e.task_id + ':' + e.task.due + ':'))) &&
      (mail.kind === 'digest' || emailPreference(person.preferences, 'email_' + e.category)) &&
      (!['assign', 'status', 'due'].includes(e.category) || (e.task.assignee || (e.category === 'due' ? e.project.lead : null)) === person.id) &&
      (e.category !== 'mention' || e.mentions?.includes(person.id)),
  );
  // A frozen message may not retain details for an event whose access was revoked.
  if (mail.rendered_at && events.length !== ids.length) return null;
  return events.length ? { person, events } : null;
}
export async function canDeliver(db, mail) {
  if ((await db.query('SELECT 1 FROM email_suppressions WHERE recipient=$1', [mail.recipient])).rowCount) return false;
  if (mail.kind === 'invitation')
    return (
      (await db.query('SELECT 1 FROM invitations WHERE id=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now()', [mail.invitation_id]))
        .rowCount > 0
    );
  if (mail.kind === 'reset')
    return (
      (
        await db.query(
          'SELECT 1 FROM password_resets r JOIN users u ON u.id=r.user_id AND u.disabled_at IS NULL WHERE r.token_hash=$1 AND r.consumed_at IS NULL AND r.expires_at>now()',
          [mail.reset_hash],
        )
      ).rowCount > 0
    );
  if (mail.kind === 'security')
    return (await db.query('SELECT 1 FROM users WHERE id=$1 AND email=$2 AND disabled_at IS NULL', [mail.user_id, mail.recipient])).rowCount > 0;
  return !!(await activityContext(db, mail));
}
export async function renderQueuedEmail(db, mail, config) {
  if (['notification', 'digest'].includes(mail.kind)) {
    const context = await activityContext(db, mail);
    if (!context) return null;
    const { person, events } = context;
    const labels = {
      mention: 'Mentions of you',
      assign: 'Task assignments',
      comment: 'New comments',
      status: 'Task status changes',
      due: 'Due date reminders',
    };
    const subject = mail.kind === 'digest' ? `Daily digest · ${person.workspace}` : `${labels[events[0].category]} · ${events[0].task.title}`;
    const items = events.map(e => ({
      title: e.task.title,
      url: workspaceLink(config, mail.workspace_id, e.task_id),
      detail: `${e.project.name} · ${e.actor || 'Automated'} · ${e.category === 'due' ? e.message : labels[e.category]}`,
      snippet: e.comment_body ?? e.snippet,
    }));
    const raw = token();
    await db.query("INSERT INTO email_unsubscribe_tokens(token_hash,workspace_id,user_id,expires_at) VALUES ($1,$2,$3,now()+interval '180 days')", [
      digest(raw),
      mail.workspace_id,
      mail.user_id,
    ]);
    const unsubscribe = `${config.APP_ORIGIN}/#unsubscribe=${raw}`,
      action = { url: workspaceLink(config, mail.workspace_id), label: 'Open workspace' };
    const paragraphs = [
      `Hello ${person.name},`,
      mail.kind === 'digest' ? `Recent activity in ${person.workspace} (up to 50 activities).` : `You have updates in ${person.workspace}.`,
    ];
    return {
      recipient: person.email,
      subject: subject.slice(0, 300),
      body: [
        ...paragraphs,
        ...items.map(i => `${i.title}\n${i.detail}\n${i.snippet}\n${i.url}`),
        `Email settings: ${config.APP_ORIGIN}/?workspace=${mail.workspace_id}#email-settings`,
        `Unsubscribe from activity emails for this workspace: ${unsubscribe}`,
      ].join('\n\n'),
      html: emailLayout({
        heading: subject,
        paragraphs,
        items,
        action,
        footer: `Activity email ${esc(person.workspace)}. <a href="${esc(unsubscribe)}">Unsubscribe</a>. Security emails and invitations remain enabled.`,
      }),
      headers: { 'List-Unsubscribe': `<${unsubscribe}>` },
      context: { ...mail.context, events: events.map(e => e.id) },
    };
  }
  const url = mail.body.match(/https?:\/\/[^\s<>]+/)?.[0];
  return {
    recipient: mail.recipient,
    subject: mail.subject,
    body: mail.body,
    headers: {},
    context: mail.context,
    html: emailLayout({
      heading: mail.subject,
      paragraphs: [mail.body],
      action: url?.startsWith(config.APP_ORIGIN + '/')
        ? { url, label: mail.kind === 'reset' ? 'Change password' : mail.kind === 'invitation' ? 'Accept invitation' : 'Open account' }
        : null,
      footer: 'Automated Sultan Workspace account message. Do not share password reset links or invitation links with others.',
    }),
  };
}
