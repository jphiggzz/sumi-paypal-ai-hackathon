CREATE TABLE gift_demo_sessions (
 id uuid PRIMARY KEY,
 token_hash text NOT NULL,
 group_id uuid NOT NULL REFERENCES gift_groups(id) ON DELETE CASCADE,
 actors jsonb NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
