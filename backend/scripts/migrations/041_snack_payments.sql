CREATE TABLE snack_payments (
 id uuid PRIMARY KEY, office_id uuid NOT NULL REFERENCES snack_offices(id) ON DELETE CASCADE,
 cycle_id uuid NOT NULL UNIQUE REFERENCES snack_cycles(id) ON DELETE CASCADE,
 owner_id text NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
 digest text NOT NULL, amount_cents integer NOT NULL CHECK (amount_cents > 0),
 status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','created','needs_review','completed','cancelled')),
 order_id text UNIQUE, merchant_id text, approval_url text, capture_id text, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX snack_one_open_payment ON snack_payments(office_id) WHERE status IN ('reserved','created','needs_review');
