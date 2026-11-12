CREATE TABLE snack_offices (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  settings jsonb NOT NULL,
  stock jsonb NOT NULL DEFAULT '[]',
  stock_checked_at timestamptz,
  revision integer NOT NULL DEFAULT 1,
  schedule_version integer NOT NULL DEFAULT 0,
  schedule_active boolean NOT NULL DEFAULT false,
  next_due_at timestamptz,
  schedule_expires_at timestamptz,
  stock_check_due boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX snack_offices_owner ON snack_offices(owner_id);
CREATE TABLE snack_cycles (
  id uuid PRIMARY KEY,
  office_id uuid NOT NULL REFERENCES snack_offices(id) ON DELETE CASCADE,
  occurrence_key text NOT NULL,
  office_revision integer NOT NULL,
  schedule_version integer,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','ready','approved','ordered','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  lease_until timestamptz,
  input jsonb NOT NULL,
  queries jsonb NOT NULL DEFAULT '[]',
  products jsonb NOT NULL DEFAULT '[]',
  reviews jsonb NOT NULL DEFAULT '[]',
  basket jsonb,
  digest text,
  error_code text,
  order_reference text,
  ordered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(office_id, occurrence_key)
);
CREATE INDEX snack_cycles_office ON snack_cycles(office_id, created_at DESC);
