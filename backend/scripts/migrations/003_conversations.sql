CREATE TABLE agent_profiles (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL UNIQUE REFERENCES auth_users(id),
  name text NOT NULL DEFAULT 'Assistant',
  permissions jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE agent_conversations (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES auth_users(id),
  agent_id uuid NOT NULL REFERENCES agent_profiles(id),
  title text NOT NULL,
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 20000),
  requested_sequence integer NOT NULL DEFAULT 0,
  processed_sequence integer NOT NULL DEFAULT 0,
  latest_revision integer,
  worker_run_id text,
  grants_active boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','queued','running','awaiting_approval','saving','failed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_conversations_owner ON agent_conversations(owner_id,updated_at DESC);
CREATE TABLE conversation_turns (
  conversation_id uuid NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  message_id uuid NOT NULL,
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  attempt integer NOT NULL DEFAULT 1,
  model text NOT NULL,
  prompt_version text NOT NULL DEFAULT 'conversation-v1',
  recovery_test boolean NOT NULL DEFAULT false,
  context_snapshot jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(conversation_id,sequence),
  UNIQUE(conversation_id,message_id)
);
CREATE TABLE conversation_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  message_key text NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id,message_key)
);
CREATE TABLE conversation_revisions (
  conversation_id uuid NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  title text NOT NULL,
  markdown text NOT NULL,
  digest text NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','saved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  saved_at timestamptz,
  PRIMARY KEY(conversation_id,revision),
  FOREIGN KEY(conversation_id,revision) REFERENCES conversation_turns(conversation_id,sequence)
);
CREATE TABLE conversation_approvals (
  conversation_id uuid NOT NULL,
  revision integer NOT NULL,
  digest text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','superseded','expired')),
  decided_by text REFERENCES auth_users(id),
  decided_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  save_run_id text,
  save_dispatches integer NOT NULL DEFAULT 0,
  PRIMARY KEY(conversation_id,revision),
  FOREIGN KEY(conversation_id,revision) REFERENCES conversation_revisions(conversation_id,revision) ON DELETE CASCADE
);
CREATE TABLE conversation_actions (
  conversation_id uuid NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  kind text NOT NULL,
  result jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(conversation_id,sequence,kind)
);
CREATE TABLE conversation_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id,event_key)
);
