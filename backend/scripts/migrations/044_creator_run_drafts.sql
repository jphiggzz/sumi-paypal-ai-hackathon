ALTER TABLE creator_runs DROP CONSTRAINT creator_runs_status_check;
ALTER TABLE creator_runs ADD CONSTRAINT creator_runs_status_check
  CHECK (status IN ('draft', 'queued', 'running', 'ready', 'failed', 'stale'));
