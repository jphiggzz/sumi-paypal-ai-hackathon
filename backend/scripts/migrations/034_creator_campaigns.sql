CREATE TABLE creator_campaigns (
 conversation_id uuid PRIMARY KEY REFERENCES workspace_chats(id) ON DELETE CASCADE,
 state jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
