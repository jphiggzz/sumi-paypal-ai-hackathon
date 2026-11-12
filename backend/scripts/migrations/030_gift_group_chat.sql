ALTER TABLE gift_members ADD COLUMN simulated boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX gift_simulated_names ON gift_members(group_id,name) WHERE simulated;
