CREATE TABLE task_comments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id text NOT NULL,
  task_id text NOT NULL,
  author_id uuid NOT NULL REFERENCES users(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  mentions uuid[] NOT NULL DEFAULT '{}',
  reactions jsonb NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX task_comments_task_idx ON task_comments(workspace_id,task_id,created_at);
CREATE TABLE project_files (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id text NOT NULL,
  task_id text,
  author_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL,
  mime text NOT NULL,
  bytes integer NOT NULL CHECK (bytes BETWEEN 1 AND 3145728),
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (octet_length(content) = bytes),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX project_files_project_idx ON project_files(workspace_id,project_id);
CREATE INDEX project_files_task_idx ON project_files(workspace_id,task_id);
CREATE TABLE user_notifications (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  recipient_id uuid NOT NULL,
  actor_id uuid REFERENCES users(id),
  project_id text NOT NULL,
  task_id text NOT NULL,
  comment_id uuid REFERENCES task_comments(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('mention','assign','comment','update')),
  message text NOT NULL,
  snippet text NOT NULL DEFAULT '',
  event_key text NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,recipient_id,event_key),
  FOREIGN KEY(workspace_id,recipient_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,task_id) REFERENCES tasks(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX user_notifications_recipient_idx ON user_notifications(workspace_id,recipient_id,created_at DESC);
CREATE TABLE recurrence_instances (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_task_id text NOT NULL,
  next_task_id text NOT NULL,
  anchor_day integer NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
  next_due date NOT NULL,
  PRIMARY KEY(workspace_id,source_task_id),
  UNIQUE(workspace_id,next_task_id)
);
CREATE TABLE automation_runs (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  checked_at timestamptz NOT NULL
);
CREATE INDEX tasks_deadline_idx ON tasks(workspace_id,(data->>'due')) WHERE data->>'status' <> 'done';
