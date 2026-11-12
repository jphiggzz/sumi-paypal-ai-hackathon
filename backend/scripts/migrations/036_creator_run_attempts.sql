ALTER TABLE creator_runs ADD COLUMN attempt uuid;
UPDATE creator_runs SET attempt=id WHERE attempt IS NULL;
ALTER TABLE creator_runs ALTER COLUMN attempt SET NOT NULL;
