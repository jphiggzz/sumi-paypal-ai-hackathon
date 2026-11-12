ALTER TABLE agent_conversations ADD COLUMN human_sequence integer NOT NULL DEFAULT 0, ADD COLUMN approval_sequence integer;
UPDATE agent_conversations SET human_sequence=requested_sequence,approval_sequence=latest_revision;
CREATE TABLE agent_work (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES auth_users(id), conversation_id uuid NOT NULL REFERENCES agent_conversations(id),
 origin_sequence integer NOT NULL, input_version integer NOT NULL DEFAULT 1, request jsonb NOT NULL, resolved_sources jsonb NOT NULL DEFAULT '[]',
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','waiting_input','waiting_job','resuming','completed','failed','cancelled','needs_reconnect','budget_exhausted','waiting_source')),
 expires_at timestamptz NOT NULL, job_id uuid, question_id uuid,
 model_calls integer NOT NULL DEFAULT 0, tool_calls integer NOT NULL DEFAULT 0, provider_calls integer NOT NULL DEFAULT 0, source_bytes integer NOT NULL DEFAULT 0,
 dispatches integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,origin_sequence)
);
ALTER TABLE conversation_turns ADD COLUMN work_id uuid REFERENCES agent_work(id),ADD COLUMN internal_kind text,ADD COLUMN work_job_version integer;
ALTER TABLE document_jobs ADD COLUMN work_id uuid REFERENCES agent_work(id);
CREATE TABLE agent_work_questions(id uuid PRIMARY KEY,work_id uuid NOT NULL REFERENCES agent_work(id),version integer NOT NULL,question text NOT NULL,schema jsonb NOT NULL,state text NOT NULL DEFAULT 'pending',expires_at timestamptz NOT NULL,answer_id uuid,answer jsonb,answer_sequence integer,UNIQUE(work_id,version));
CREATE TABLE agent_work_continuations(job_id uuid NOT NULL REFERENCES document_jobs(id),job_version integer NOT NULL,work_id uuid NOT NULL REFERENCES agent_work(id),sequence integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(job_id,job_version));
CREATE TABLE agent_work_charges(work_id uuid NOT NULL REFERENCES agent_work(id),receipt text NOT NULL,kind text NOT NULL,amount integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(work_id,receipt));
CREATE TABLE agent_source_leases(owner_id text NOT NULL,connection_id uuid NOT NULL,connection_version integer NOT NULL,resource_id text NOT NULL,refresh_id uuid NOT NULL,expires_at timestamptz NOT NULL,PRIMARY KEY(owner_id,connection_id,connection_version,resource_id));
CREATE INDEX agent_work_conversation ON agent_work(conversation_id,created_at);
CREATE TABLE agent_work_source_waiters(work_id uuid NOT NULL REFERENCES agent_work(id),refresh_id uuid NOT NULL,workflow_run_id text NOT NULL,sequence integer,PRIMARY KEY(work_id,refresh_id));
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT p.id,p.owner_id,p.config_version,v.* FROM agent_profiles p JOIN agent_config_versions v ON v.agent_id=p.id AND v.version=p.config_version WHERE v.instructions='' AND jsonb_array_length(v.tools)=11 AND v.tools ? 'read_job_result' FOR UPDATE OF p LOOP
 INSERT INTO agent_config_versions(agent_id,version,owner_id,instructions,tools,model,context_bytes,max_output_tokens) VALUES(r.agent_id,r.config_version+1,r.owner_id,'',r.tools||'["list_connected_sources","refresh_connected_source","start_document_job","inspect_document_job","control_document_job","request_clarification"]'::jsonb,r.model,r.context_bytes,r.max_output_tokens);
 UPDATE agent_profiles SET config_version=r.config_version+1 WHERE id=r.agent_id;
 END LOOP;
END $$;
