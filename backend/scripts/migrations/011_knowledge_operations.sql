CREATE TABLE agent_config_versions (
 agent_id uuid NOT NULL REFERENCES agent_profiles(id), version integer NOT NULL CHECK(version>0),
 owner_id text NOT NULL REFERENCES auth_users(id), instructions text NOT NULL, tools jsonb NOT NULL,
 model text NOT NULL, context_bytes integer NOT NULL CHECK(context_bytes BETWEEN 8000 AND 32000),
 max_output_tokens integer NOT NULL DEFAULT 3000 CHECK(max_output_tokens BETWEEN 512 AND 3000),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(agent_id,version)
);
ALTER TABLE agent_profiles ADD COLUMN config_version integer NOT NULL DEFAULT 1;
INSERT INTO agent_config_versions SELECT id,1,owner_id,'', '["read_context","read_revision","create_draft","reply","read_fixture_document","list_fixture_documents","propose_fixture_note","search_memory","read_history","search_sources"]'::jsonb,'amazon/nova-micro',16000,3000,now() FROM agent_profiles;
ALTER TABLE conversation_turns ADD COLUMN config_version integer;
UPDATE conversation_turns SET config_version=1;
CREATE FUNCTION reject_agent_config_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Agent configurations are immutable'; END $$;
CREATE TRIGGER immutable_agent_configs BEFORE UPDATE OR DELETE ON agent_config_versions FOR EACH ROW EXECUTE FUNCTION reject_agent_config_mutation();
CREATE TABLE source_records (
 id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES auth_users(id), connection_id uuid NOT NULL REFERENCES agent_connections(id),
 connection_version integer NOT NULL, resource_id text NOT NULL, version integer NOT NULL,
 title text NOT NULL, url text NOT NULL, content text NOT NULL CHECK(octet_length(content)<=32768), content_hash text NOT NULL,
 provider_version text NOT NULL, fixture boolean NOT NULL, fetched_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 UNIQUE(connection_id,resource_id)
);
CREATE INDEX source_owner ON source_records(owner_id,connection_id);
CREATE INDEX source_search ON source_records USING gin(to_tsvector('simple',content));
CREATE TABLE source_versions (source_id uuid NOT NULL REFERENCES source_records(id),version integer NOT NULL,owner_id text NOT NULL,metadata jsonb NOT NULL,PRIMARY KEY(source_id,version));
CREATE TRIGGER immutable_source_versions BEFORE UPDATE OR DELETE ON source_versions FOR EACH ROW EXECUTE FUNCTION reject_agent_config_mutation();
CREATE TABLE connector_usage (day date NOT NULL, budget_key text NOT NULL, requests integer NOT NULL, bytes bigint NOT NULL,PRIMARY KEY(day,budget_key));
CREATE TABLE source_refreshes (id uuid PRIMARY KEY,owner_id text NOT NULL,connection_id uuid NOT NULL,connection_version integer NOT NULL,resource_id text NOT NULL,fixture_revision integer NOT NULL,state text NOT NULL CHECK(state IN ('running','completed','failed')),source_id uuid,error_code text,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE drive_oauth_states (state_hash text PRIMARY KEY,owner_id text NOT NULL,connection_id uuid NOT NULL,connection_version integer NOT NULL,verifier text NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE drive_credentials (connection_id uuid PRIMARY KEY REFERENCES agent_connections(id),owner_id text NOT NULL,sealed text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
-- Replace only the nonfixture-state restriction. Fixture restrictions remain.
DO $$ DECLARE c record; BEGIN FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='agent_connections'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%requires_authorization%' AND pg_get_constraintdef(oid) LIKE '%provider%' LOOP EXECUTE format('ALTER TABLE agent_connections DROP CONSTRAINT %I',c.conname); END LOOP; END $$;
ALTER TABLE agent_connections ADD CONSTRAINT nonfixture_connection_states CHECK(provider IN ('fixture','google') OR status IN ('requires_authorization','disconnected'));
CREATE FUNCTION protect_turn_config() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.config_version IS NOT NULL AND NEW.config_version IS DISTINCT FROM OLD.config_version THEN RAISE EXCEPTION 'Turn configuration is pinned'; END IF; RETURN NEW; END $$;
CREATE TRIGGER immutable_turn_config BEFORE UPDATE ON conversation_turns FOR EACH ROW EXECUTE FUNCTION protect_turn_config();
CREATE TABLE agent_repairs(id uuid PRIMARY KEY,owner_id text NOT NULL,conversation_id uuid NOT NULL REFERENCES agent_conversations(id),original_sequence integer NOT NULL,new_sequence integer NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE source_refreshes ADD COLUMN workflow_run_id text;
ALTER TABLE source_refreshes ADD COLUMN attempts integer NOT NULL DEFAULT 1;
