ALTER TABLE memberships DROP CONSTRAINT memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK(role IN ('owner','admin','member','guest'));
ALTER TABLE invitations DROP CONSTRAINT invitations_role_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_role_check CHECK(role IN ('admin','member','guest'));
ALTER TABLE invitations ADD COLUMN delivery text NOT NULL DEFAULT 'email' CHECK(delivery IN ('email','link'));
ALTER TABLE invitations ADD COLUMN project_id text;
ALTER TABLE invitations ADD COLUMN project_permission text CHECK(project_permission IN ('viewer','commenter','editor'));
ALTER TABLE invitations ADD FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) ON DELETE CASCADE;
ALTER TABLE workspaces ADD COLUMN slug text UNIQUE CHECK(slug ~ '^[a-z0-9][a-z0-9-]{2,59}$');
ALTER TABLE workspaces ADD COLUMN settings jsonb NOT NULL DEFAULT '{}';
CREATE TABLE project_access_requests (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  project_id text NOT NULL,
  user_id uuid NOT NULL,
  permission text NOT NULL CHECK(permission IN ('viewer','commenter','editor')),
  reason text NOT NULL DEFAULT '' CHECK(length(reason)<=1000),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  decided_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE(workspace_id,project_id,user_id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) ON DELETE CASCADE,
  FOREIGN KEY(workspace_id,user_id) REFERENCES memberships(workspace_id,user_id) ON DELETE CASCADE
);
