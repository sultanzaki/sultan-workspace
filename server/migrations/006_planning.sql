CREATE TABLE calendar_events (
  workspace_id uuid NOT NULL,
  id text NOT NULL,
  project_id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY(workspace_id,id),
  FOREIGN KEY(workspace_id,project_id) REFERENCES projects(workspace_id,id) ON DELETE CASCADE
);
CREATE INDEX calendar_events_project_idx ON calendar_events(workspace_id,project_id);
