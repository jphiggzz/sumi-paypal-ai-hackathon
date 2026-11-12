CREATE TABLE creator_runs (
 id uuid PRIMARY KEY,
 conversation_id uuid NOT NULL REFERENCES workspace_chats(id) ON DELETE CASCADE,
 message_id uuid NOT NULL REFERENCES workspace_chat_messages(id) ON DELETE CASCADE,
 revision integer NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','ready','failed','stale')),
 input jsonb NOT NULL,
 activity jsonb NOT NULL DEFAULT '[]',
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX creator_runs_conversation ON creator_runs(conversation_id,created_at);
