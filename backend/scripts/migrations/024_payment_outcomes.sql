CREATE TABLE sandbox_payment_followups(payment_id uuid NOT NULL REFERENCES sandbox_payment_proposals(id),state text NOT NULL,sequence integer NOT NULL,PRIMARY KEY(payment_id,state));
INSERT INTO sandbox_payment_followups SELECT id,state,followup_sequence FROM sandbox_payment_proposals WHERE followup_sequence IS NOT NULL;
CREATE TRIGGER immutable_payment_followups BEFORE UPDATE OR DELETE ON sandbox_payment_followups FOR EACH ROW EXECUTE FUNCTION reject_agent_config_mutation();
