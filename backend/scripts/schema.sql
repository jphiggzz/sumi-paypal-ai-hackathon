CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY,
  scenario text NOT NULL CHECK (scenario IN ('payout', 'review')),
  approval jsonb NOT NULL,
  status text NOT NULL DEFAULT 'waiting',
  event_log jsonb NOT NULL DEFAULT '{}'::jsonb,
  deal jsonb,
  payout_request_id text UNIQUE,
  payment_started_at timestamptz,
  batch_id text UNIQUE,
  item_id text UNIQUE,
  recovery_test boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS demo_quota (
  day date PRIMARY KEY,
  runs integer NOT NULL CHECK (runs > 0)
);

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS workflow_run_id text UNIQUE;
