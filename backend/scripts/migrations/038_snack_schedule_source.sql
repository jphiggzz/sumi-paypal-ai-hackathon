ALTER TABLE snack_offices ADD COLUMN schedule_source text NOT NULL DEFAULT 'channel3' CHECK (schedule_source IN ('channel3', 'simulated'));
