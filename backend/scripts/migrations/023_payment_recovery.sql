ALTER TABLE sandbox_payment_proposals ADD COLUMN recovery_run_id text,ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0,ADD COLUMN check_limit integer NOT NULL DEFAULT 16;
