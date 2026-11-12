CREATE TABLE workspace_chats (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 title text NOT NULL DEFAULT 'New chat', mode text NOT NULL CHECK(mode IN ('creators','shopping')),
 revision integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_chats_owner ON workspace_chats(owner_id,updated_at DESC);
CREATE TABLE workspace_chat_messages (
 id uuid PRIMARY KEY, conversation_id uuid NOT NULL REFERENCES workspace_chats(id) ON DELETE CASCADE,
 sequence bigserial UNIQUE, role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL,
 mode text NOT NULL CHECK(mode IN ('creators','shopping')), parent_id uuid REFERENCES workspace_chat_messages(id),
 status text NOT NULL CHECK(status IN ('streaming','completed','interrupted','failed')),
 lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workspace_messages_chat ON workspace_chat_messages(conversation_id,sequence);
