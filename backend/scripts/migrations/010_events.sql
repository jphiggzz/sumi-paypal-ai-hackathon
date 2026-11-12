-- Fixture event intake only. There is no provider registration or OAuth callback.
CREATE TABLE agent_event_sources (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES auth_users(id),
  conversation_id uuid NOT NULL REFERENCES agent_conversations(id),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 100),
  signing_generation integer NOT NULL DEFAULT 1 CHECK (signing_generation BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','cancelled')),
  instruction text NOT NULL CHECK (length(instruction) BETWEEN 1 AND 2000),
  execution_mode text NOT NULL DEFAULT 'checkpoint' CHECK (execution_mode IN ('checkpoint','capability_check')),
  capability_request jsonb,
  create_request jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  fixture boolean NOT NULL DEFAULT true CHECK (fixture),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((execution_mode='checkpoint' AND capability_request IS NULL) OR (execution_mode='capability_check' AND capability_request IS NOT NULL))
);
CREATE INDEX agent_event_sources_owner ON agent_event_sources(owner_id,created_at DESC);
CREATE TABLE agent_event_source_revisions (
  source_id uuid NOT NULL REFERENCES agent_event_sources(id),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 100),
  owner_id text NOT NULL REFERENCES auth_users(id),
  action text NOT NULL CHECK (action IN ('create','edit','pause','resume','rotate','cancel')),
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_id,version)
);
CREATE TABLE agent_event_inbox (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES agent_event_sources(id),
  source_version integer NOT NULL,
  owner_id text NOT NULL REFERENCES auth_users(id),
  conversation_id uuid NOT NULL REFERENCES agent_conversations(id),
  event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 120),
  body_digest text NOT NULL CHECK (body_digest ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz NOT NULL,
  data jsonb NOT NULL CHECK (octet_length(data::text)<=8192),
  sequence integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_id,event_key),
  FOREIGN KEY(source_id,source_version) REFERENCES agent_event_source_revisions(source_id,version),
  FOREIGN KEY(conversation_id,sequence) REFERENCES conversation_turns(conversation_id,sequence)
);
CREATE INDEX agent_event_inbox_owner ON agent_event_inbox(owner_id,created_at DESC);
ALTER TABLE conversation_turns ADD COLUMN event_id uuid REFERENCES agent_event_inbox(id);
CREATE UNIQUE INDEX conversation_turns_event ON conversation_turns(event_id) WHERE event_id IS NOT NULL;
CREATE FUNCTION prevent_event_source_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Event source revisions are immutable';
END;
$$;
CREATE TRIGGER agent_event_source_revisions_immutable BEFORE UPDATE OR DELETE ON agent_event_source_revisions
  FOR EACH ROW EXECUTE FUNCTION prevent_event_source_revision_mutation();
