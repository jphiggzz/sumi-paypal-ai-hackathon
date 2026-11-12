CREATE TABLE agent_tasks (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES auth_users(id),
  instruction text NOT NULL CHECK (length(instruction) BETWEEN 3 AND 2000),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 20000),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','awaiting_approval','saving','completed','rejected','cancelled','failed')),
  permissions jsonb NOT NULL,
  grants_active boolean NOT NULL DEFAULT true,
  workflow_run_id text,
  attempt integer NOT NULL DEFAULT 1,
  model text NOT NULL,
  prompt_version text NOT NULL DEFAULT 'foundation-v1',
  recovery_test boolean NOT NULL DEFAULT false,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_tasks_owner_created ON agent_tasks(owner_id, created_at DESC);
CREATE TABLE agent_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  message_key text NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant','tool','system')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,message_key)
);
CREATE TABLE agent_artifacts (
  task_id uuid PRIMARY KEY REFERENCES agent_tasks(id) ON DELETE CASCADE,
  title text NOT NULL,
  markdown text NOT NULL,
  digest text NOT NULL,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','saved')),
  created_at timestamptz NOT NULL DEFAULT now(),
  saved_at timestamptz
);
CREATE TABLE agent_approvals (
  task_id uuid PRIMARY KEY REFERENCES agent_tasks(id) ON DELETE CASCADE,
  digest text NOT NULL,
  decision text CHECK (decision IN ('approve','reject')),
  decided_by text REFERENCES auth_users(id),
  decided_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days'
);
CREATE TABLE agent_actions (
  task_id uuid NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  kind text NOT NULL,
  result jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(task_id,kind)
);
CREATE TABLE agent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,event_key)
);
CREATE TABLE agent_daily_quota (
  day date NOT NULL,
  owner_id text NOT NULL REFERENCES auth_users(id),
  tasks integer NOT NULL,
  PRIMARY KEY(day,owner_id)
);
