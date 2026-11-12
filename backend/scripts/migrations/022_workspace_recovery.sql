ALTER TABLE agent_workspace_requests ADD COLUMN attempts integer NOT NULL DEFAULT 0, ADD COLUMN lease_until timestamptz;
