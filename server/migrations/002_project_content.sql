CREATE TABLE content_versions (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0
);
CREATE TABLE projects (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(workspace_id,id)
);
CREATE TABLE tasks (
  workspace_id uuid NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX task_keys_idx ON tasks(workspace_id,project_id,(data->>'key'));
CREATE INDEX tasks_project_idx ON tasks(workspace_id,project_id);
CREATE TABLE saved_views (
  workspace_id uuid NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE workspace_preferences (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(workspace_id,user_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE
);
CREATE TABLE content_mutations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  id uuid NOT NULL,
  digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,user_id,id)
);
CREATE TABLE content_activity (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES users(id),
  project_id text,
  task_id text,
  verb text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_activity_workspace_idx ON content_activity(workspace_id,at DESC);
