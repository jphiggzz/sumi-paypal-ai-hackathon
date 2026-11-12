CREATE TABLE agent_model_charges (
 id uuid PRIMARY KEY,
 day date NOT NULL REFERENCES agent_model_budget(day),
 model text NOT NULL,
 held_usd numeric(12,6) NOT NULL CHECK(held_usd>0),
 generation_id text UNIQUE,
 confirmed_usd numeric(12,6) CHECK(confirmed_usd>=0),
 usage jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 checked_at timestamptz,
 settled_at timestamptz
);
CREATE INDEX agent_model_charges_pending ON agent_model_charges(day,checked_at) WHERE confirmed_usd IS NULL AND generation_id IS NOT NULL;
