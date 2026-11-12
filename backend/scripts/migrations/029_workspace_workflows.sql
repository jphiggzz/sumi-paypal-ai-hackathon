CREATE TABLE workspace_workflow_links (
 id uuid PRIMARY KEY,
 conversation_id uuid NOT NULL REFERENCES workspace_chats(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('campaign','gift')),
 resource_id uuid NOT NULL,
 draft jsonb NOT NULL DEFAULT '{}'::jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,kind)
);
CREATE INDEX workspace_workflow_resource ON workspace_workflow_links(kind,resource_id);
