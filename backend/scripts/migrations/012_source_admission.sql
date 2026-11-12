ALTER TABLE source_refreshes DROP CONSTRAINT source_refreshes_state_check;
ALTER TABLE source_refreshes ADD CONSTRAINT source_refreshes_state_check CHECK(state IN ('queued','running','completed','failed'));
