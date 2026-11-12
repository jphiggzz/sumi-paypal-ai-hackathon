ALTER TABLE agent_work ADD COLUMN initial_request jsonb;
UPDATE agent_work SET initial_request=request;
ALTER TABLE agent_work ALTER COLUMN initial_request SET NOT NULL;
CREATE FUNCTION protect_agent_work_authority() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR NEW.origin_sequence IS DISTINCT FROM OLD.origin_sequence OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.initial_request IS DISTINCT FROM OLD.initial_request OR (NEW.request-'fields') IS DISTINCT FROM (OLD.request-'fields') THEN RAISE EXCEPTION 'Work authority is immutable'; END IF;
 IF NEW.model_calls<OLD.model_calls OR NEW.tool_calls<OLD.tool_calls OR NEW.provider_calls<OLD.provider_calls OR NEW.source_bytes<OLD.source_bytes OR NEW.stage_calls<OLD.stage_calls OR NEW.dispatches<OLD.dispatches THEN RAISE EXCEPTION 'Work allowance cannot reset'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_agent_work_authority BEFORE UPDATE ON agent_work FOR EACH ROW EXECUTE FUNCTION protect_agent_work_authority();
CREATE TRIGGER immutable_agent_work_charges BEFORE UPDATE OR DELETE ON agent_work_charges FOR EACH ROW EXECUTE FUNCTION reject_agent_config_mutation();
CREATE TRIGGER immutable_agent_work_continuations BEFORE UPDATE OR DELETE ON agent_work_continuations FOR EACH ROW EXECUTE FUNCTION reject_agent_config_mutation();
