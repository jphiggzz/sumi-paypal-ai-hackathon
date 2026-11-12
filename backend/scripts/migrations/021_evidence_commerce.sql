CREATE TABLE evidence_extractions (
 job_id uuid NOT NULL REFERENCES document_jobs(id), source_index integer NOT NULL,
 state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, claim_id uuid, lease_until timestamptz,
 output jsonb, usage jsonb, PRIMARY KEY(job_id,source_index)
);
CREATE TABLE structured_results (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES auth_users(id), work_id uuid NOT NULL REFERENCES agent_work(id),
 job_id uuid NOT NULL REFERENCES document_jobs(id), source_id uuid NOT NULL, source_version integer NOT NULL,
 source_index integer NOT NULL, title text NOT NULL, revision integer NOT NULL DEFAULT 1, facts jsonb NOT NULL,
 UNIQUE(job_id,source_index)
);
CREATE TABLE structured_result_versions (
 result_id uuid NOT NULL REFERENCES structured_results(id), revision integer NOT NULL, facts jsonb NOT NULL,
 origin text NOT NULL CHECK(origin IN ('extraction','owner')), created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(result_id,revision)
);
CREATE TRIGGER immutable_result_versions BEFORE UPDATE OR DELETE ON structured_result_versions FOR EACH ROW EXECUTE FUNCTION reject_agent_config_mutation();
CREATE TABLE sandbox_payment_proposals (
 id uuid PRIMARY KEY,owner_id text NOT NULL REFERENCES auth_users(id), work_id uuid NOT NULL UNIQUE REFERENCES agent_work(id),
 result_id uuid NOT NULL REFERENCES structured_results(id), result_revision integer NOT NULL,
 payload jsonb NOT NULL,digest text NOT NULL,state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','submitting','pending_provider','succeeded','failed','rejected','blocked','needs_review')),
 followup_sequence integer,workflow_run_id text,claim_id uuid,lease_until timestamptz,submission_started_at timestamptz,batch_id text,item_id text,
 checks integer NOT NULL DEFAULT 0,submissions integer NOT NULL DEFAULT 0,error_code text,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sandbox_payment_reservations (
 payment_id uuid PRIMARY KEY REFERENCES sandbox_payment_proposals(id),owner_id text NOT NULL,work_id uuid NOT NULL UNIQUE,
 cents integer NOT NULL CHECK(cents BETWEEN 1 AND 10000),state text NOT NULL CHECK(state IN ('reserved','spent','released')),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sandbox_payment_events (
 payment_id uuid NOT NULL REFERENCES sandbox_payment_proposals(id),event_key text NOT NULL,detail jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(payment_id,event_key)
);
CREATE TRIGGER immutable_sandbox_payment_events BEFORE UPDATE OR DELETE ON sandbox_payment_events FOR EACH ROW EXECUTE FUNCTION reject_agent_config_mutation();
CREATE FUNCTION protect_sandbox_payment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.work_id IS DISTINCT FROM OLD.work_id OR NEW.result_id IS DISTINCT FROM OLD.result_id OR NEW.result_revision IS DISTINCT FROM OLD.result_revision OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.digest IS DISTINCT FROM OLD.digest OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN RAISE EXCEPTION 'Payment authority is immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER immutable_sandbox_payment BEFORE UPDATE ON sandbox_payment_proposals FOR EACH ROW EXECUTE FUNCTION protect_sandbox_payment();
CREATE TABLE agent_workspaces (
 work_id uuid PRIMARY KEY REFERENCES agent_work(id),owner_id text NOT NULL,revision integer NOT NULL,state jsonb NOT NULL
);
CREATE TABLE agent_workspace_versions (
 work_id uuid NOT NULL REFERENCES agent_work(id),revision integer NOT NULL,state jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(work_id,revision)
);
CREATE TRIGGER immutable_workspace_versions BEFORE UPDATE OR DELETE ON agent_workspace_versions FOR EACH ROW EXECUTE FUNCTION reject_agent_config_mutation();
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT p.id,p.owner_id,p.config_version,v.* FROM agent_profiles p JOIN agent_config_versions v ON v.agent_id=p.id AND v.version=p.config_version WHERE v.instructions='' AND jsonb_array_length(v.tools)=17 AND v.tools ? 'start_document_job' FOR UPDATE OF p LOOP
 INSERT INTO agent_config_versions(agent_id,version,owner_id,instructions,tools,model,context_bytes,max_output_tokens) VALUES(r.agent_id,r.config_version+1,r.owner_id,'',r.tools||'["propose_sandbox_payment"]'::jsonb,r.model,r.context_bytes,r.max_output_tokens);
 UPDATE agent_profiles SET config_version=r.config_version+1 WHERE id=r.id;
 END LOOP;
END $$;
CREATE TABLE agent_workspace_requests (
 id uuid PRIMARY KEY, work_id uuid NOT NULL REFERENCES agent_work(id),owner_id text NOT NULL,prompt text NOT NULL,
 expected_revision integer NOT NULL,status text NOT NULL DEFAULT 'queued',output jsonb,error_code text,usage jsonb,
 workflow_run_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
