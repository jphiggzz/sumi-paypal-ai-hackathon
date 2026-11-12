CREATE TABLE gift_groups (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 recipient text NOT NULL, occasion text NOT NULL, reserve_cents integer NOT NULL,
 invite_hash text NOT NULL UNIQUE, revision integer NOT NULL DEFAULT 1,
 selected_job uuid, selected_option text, order_reference text,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gift_members (
 id uuid PRIMARY KEY, group_id uuid NOT NULL REFERENCES gift_groups(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE, name text NOT NULL,
 limit_cents integer NOT NULL DEFAULT 0, approved_digest text,
 UNIQUE(group_id,user_id)
);
CREATE TABLE gift_messages (
 id uuid PRIMARY KEY, member_id uuid NOT NULL REFERENCES gift_members(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gift_facts (
 id uuid PRIMARY KEY, member_id uuid NOT NULL REFERENCES gift_members(id) ON DELETE CASCADE,
 message_id uuid NOT NULL UNIQUE REFERENCES gift_messages(id) ON DELETE CASCADE,
 content text NOT NULL, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gift_jobs (
 id uuid PRIMARY KEY, group_id uuid NOT NULL REFERENCES gift_groups(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES gift_members(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('chat','plan')), revision integer NOT NULL,
 status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0, lease_until timestamptz,
 input jsonb NOT NULL, result jsonb, error_code text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE gift_contributions (
 id uuid PRIMARY KEY, group_id uuid NOT NULL REFERENCES gift_groups(id) ON DELETE CASCADE,
 member_id uuid NOT NULL REFERENCES gift_members(id) ON DELETE CASCADE,
 digest text NOT NULL, amount_cents integer NOT NULL CHECK(amount_cents>0),
 status text NOT NULL DEFAULT 'creating', order_id text UNIQUE, merchant_id text,
 approval_url text, capture_id text UNIQUE, error_code text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gift_jobs_group ON gift_jobs(group_id,created_at DESC);
CREATE INDEX gift_messages_member ON gift_messages(member_id,created_at);
