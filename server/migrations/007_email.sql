CREATE TABLE email_events (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  actor_id uuid REFERENCES users(id),
  project_id text NOT NULL,
  task_id text NOT NULL,
  comment_id uuid REFERENCES task_comments(id) ON DELETE CASCADE,
  category text NOT NULL CHECK(category IN ('mention','assign','comment','status','due')),
  message text NOT NULL,
  snippet text NOT NULL DEFAULT '',
  event_key text NOT NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,recipient_id,event_key),
  FOREIGN KEY(workspace_id,recipient_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX email_events_pending_idx ON email_events(created_at) WHERE processed_at IS NULL;
CREATE INDEX email_events_digest_idx ON email_events(workspace_id,recipient_id,created_at);
CREATE TABLE email_digest_runs (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  period_end timestamptz NOT NULL,
  weekday boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,user_id,period_end),
  FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE
);
CREATE TABLE email_unsubscribe_tokens (
  token_hash text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE
);
ALTER TABLE mail_outbox ADD COLUMN kind text NOT NULL DEFAULT 'invitation' CHECK(kind IN ('invitation','reset','notification','digest','security'));
UPDATE mail_outbox SET kind='reset' WHERE reset_hash IS NOT NULL;
ALTER TABLE mail_outbox ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE;
UPDATE mail_outbox o SET workspace_id=i.workspace_id FROM invitations i WHERE i.id=o.invitation_id;
ALTER TABLE mail_outbox ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE mail_outbox ADD COLUMN context jsonb NOT NULL DEFAULT '{}';
ALTER TABLE mail_outbox ADD COLUMN html text NOT NULL DEFAULT '';
ALTER TABLE mail_outbox ADD COLUMN headers jsonb NOT NULL DEFAULT '{}';
ALTER TABLE mail_outbox ADD COLUMN rendered_at timestamptz;
ALTER TABLE mail_outbox ADD COLUMN expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days';
ALTER TABLE mail_outbox ADD COLUMN dedupe_key text UNIQUE;
ALTER TABLE mail_outbox ADD COLUMN claim_token uuid;
ALTER TABLE mail_outbox ADD COLUMN locked_until timestamptz;
ALTER TABLE mail_outbox ADD COLUMN delivery_status text NOT NULL DEFAULT 'queued';
ALTER TABLE mail_outbox ADD COLUMN error_code text;
ALTER TABLE mail_outbox ADD COLUMN provider_id text UNIQUE;
ALTER TABLE mail_outbox ADD COLUMN finished_at timestamptz;
UPDATE mail_outbox SET delivery_status='accepted',finished_at=sent_at WHERE sent_at IS NOT NULL;
CREATE INDEX mail_outbox_ready_idx ON mail_outbox(next_attempt_at) WHERE finished_at IS NULL;
CREATE TABLE email_suppressions (recipient text PRIMARY KEY,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE email_webhook_events (id text PRIMARY KEY,received_at timestamptz NOT NULL DEFAULT now());
