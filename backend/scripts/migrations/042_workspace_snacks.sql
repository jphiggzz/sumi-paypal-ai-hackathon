ALTER TABLE workspace_workflow_links DROP CONSTRAINT workspace_workflow_links_kind_check;
ALTER TABLE workspace_workflow_links ADD CONSTRAINT workspace_workflow_links_kind_check CHECK (kind IN ('campaign','gift','snack'));
