CREATE TABLE agent_routines (
 id uuid PRIMARY KEY,
 conversation_id uuid NOT NULL REFERENCES agent_conversations(id),
 owner_id text NOT NULL REFERENCES auth_users(id),
 version integer NOT NULL DEFAULT 1,
 instruction text NOT NULL CHECK(length(instruction) BETWEEN 1 AND 2000),
 execution_mode text NOT NULL CHECK(execution_mode IN ('checkpoint','assistant')),
 timezone text NOT NULL,
 next_due_at timestamptz NOT NULL,
 interval_seconds integer CHECK(interval_seconds BETWEEN 60 AND 604800),
 max_runs integer NOT NULL CHECK(max_runs BETWEEN 1 AND 10),
 run_count integer NOT NULL DEFAULT 0,
 expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','cancelled','completed','expired','blocked')),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_routines_owner ON agent_routines(owner_id,status);
CREATE TABLE routine_occurrences (
 id uuid PRIMARY KEY,
 routine_id uuid NOT NULL REFERENCES agent_routines(id),
 version integer NOT NULL,
 due_at timestamptz NOT NULL,
 conversation_id uuid NOT NULL REFERENCES agent_conversations(id),
 sequence integer,
 status text NOT NULL DEFAULT 'queued',
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(routine_id,version,due_at)
);
ALTER TABLE conversation_turns ADD COLUMN execution_mode text NOT NULL DEFAULT 'assistant' CHECK(execution_mode IN ('checkpoint','assistant'));
ALTER TABLE conversation_turns ADD COLUMN occurrence_id uuid REFERENCES routine_occurrences(id);
ALTER TABLE agent_conversations ADD COLUMN read_sequence integer NOT NULL DEFAULT 0;
CREATE TABLE agent_dispatch_outbox (
 id text PRIMARY KEY,
 conversation_id uuid NOT NULL REFERENCES agent_conversations(id),
 sequence integer NOT NULL,
 kind text NOT NULL CHECK(kind IN ('turn','save')),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','dispatched','completed','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0,
 last_attempt_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_dispatch_pending ON agent_dispatch_outbox(state,updated_at);
CREATE TABLE agent_model_budget (
 day date PRIMARY KEY,
 reserved_usd numeric(12,6) NOT NULL DEFAULT 0,
 calls integer NOT NULL DEFAULT 0
);
