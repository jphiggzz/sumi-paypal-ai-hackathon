ALTER TABLE snack_offices ADD COLUMN headcount_mode text NOT NULL DEFAULT 'additional' CHECK (headcount_mode IN ('additional','total'));
