-- Explicit human-owned factual memory; model tools have no write API.
CREATE TABLE agent_memories (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES auth_users(id),
  scope text NOT NULL CHECK (scope IN ('agent','conversation')),
  conversation_id uuid REFERENCES agent_conversations(id),
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 120),
  normalized_key text NOT NULL CHECK (length(normalized_key) BETWEEN 1 AND 240),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 500),
  version integer NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 100),
  source jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope='agent' AND conversation_id IS NULL) OR (scope='conversation' AND conversation_id IS NOT NULL))
);
CREATE INDEX agent_memories_owner ON agent_memories(owner_id);
-- Expired keys remain reserved until explicitly forgotten. Tombstones release keys.
CREATE UNIQUE INDEX agent_memories_agent_key ON agent_memories(owner_id,normalized_key) WHERE scope='agent' AND deleted_at IS NULL;
CREATE UNIQUE INDEX agent_memories_conversation_key ON agent_memories(owner_id,conversation_id,normalized_key) WHERE scope='conversation' AND deleted_at IS NULL;
CREATE TABLE agent_memory_revisions (
  memory_id uuid NOT NULL REFERENCES agent_memories(id),
  version integer NOT NULL CHECK (version BETWEEN 1 AND 100),
  owner_id text NOT NULL REFERENCES auth_users(id),
  request_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('remember','update','forget')),
  request jsonb NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(memory_id,version),
  UNIQUE(owner_id,request_id)
);
-- Revisions/provenance are append-only, including after a fact is forgotten.
CREATE FUNCTION prevent_memory_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Memory revisions are immutable';
END;
$$;
CREATE TRIGGER agent_memory_revisions_immutable BEFORE UPDATE OR DELETE ON agent_memory_revisions
  FOR EACH ROW EXECUTE FUNCTION prevent_memory_revision_mutation();
