ALTER TABLE snack_offices ADD COLUMN invite_hash text UNIQUE;
CREATE TABLE snack_members (
  id uuid PRIMARY KEY, office_id uuid NOT NULL REFERENCES snack_offices(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  name text NOT NULL, preferences jsonb, shared boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(office_id,user_id)
);
CREATE TABLE snack_messages (
  id uuid PRIMARY KEY, member_id uuid NOT NULL REFERENCES snack_members(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user','assistant')), content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
