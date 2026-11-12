CREATE TABLE agent_model_capacity (
  model text PRIMARY KEY,
  next_call_at timestamptz NOT NULL
);
