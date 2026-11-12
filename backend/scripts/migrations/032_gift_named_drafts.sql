ALTER TABLE gift_groups ADD COLUMN title text;
ALTER TABLE gift_groups ALTER COLUMN recipient DROP NOT NULL;
ALTER TABLE gift_groups ALTER COLUMN occasion DROP NOT NULL;
