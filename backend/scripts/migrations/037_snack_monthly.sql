ALTER TABLE snack_offices ADD COLUMN schedule_cadence text NOT NULL DEFAULT 'fortnight' CHECK (schedule_cadence IN ('fortnight', 'monthly'));
ALTER TABLE snack_offices ADD COLUMN schedule_anchor_day integer CHECK (schedule_anchor_day BETWEEN 1 AND 31);
