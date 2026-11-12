ALTER TABLE snack_cycles ADD COLUMN discussion jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE snack_cycles ADD COLUMN source text NOT NULL DEFAULT 'channel3' CHECK (source IN ('channel3','simulated'));
