CREATE TABLE agent_capability_invocations (
 id text PRIMARY KEY,
 conversation_id uuid NOT NULL REFERENCES agent_conversations(id),
 sequence integer NOT NULL,
 owner_id text NOT NULL REFERENCES auth_users(id),
 workflow_run_id text NOT NULL,
 tool_id text NOT NULL,
 tool_version integer NOT NULL,
 input_digest text NOT NULL,
 state text NOT NULL CHECK(state IN ('running','completed','failed')),
 attempts integer NOT NULL DEFAULT 1,
 connection_id uuid REFERENCES agent_connections(id),
 connection_version integer,
 error_code text,
 retry_after_ms integer,
 duration_ms integer,
 output_bytes integer,
 started_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 FOREIGN KEY(conversation_id,sequence) REFERENCES conversation_turns(conversation_id,sequence)
);
CREATE INDEX agent_capability_conversation ON agent_capability_invocations(conversation_id,sequence,started_at);
CREATE TABLE agent_capability_results (
 invocation_id text PRIMARY KEY REFERENCES agent_capability_invocations(id),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE conversation_turns DROP CONSTRAINT conversation_turns_execution_mode_check;
ALTER TABLE conversation_turns ADD CONSTRAINT conversation_turns_execution_mode_check CHECK(execution_mode IN ('checkpoint','assistant','capability_check'));
ALTER TABLE conversation_turns ADD COLUMN capability_request jsonb;
ALTER TABLE agent_routines DROP CONSTRAINT agent_routines_execution_mode_check;
ALTER TABLE agent_routines ADD CONSTRAINT agent_routines_execution_mode_check CHECK(execution_mode IN ('checkpoint','assistant','capability_check'));
ALTER TABLE agent_routines ADD COLUMN capability_request jsonb;
