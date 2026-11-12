CREATE TABLE agent_connections (
 id uuid PRIMARY KEY,
 owner_id text NOT NULL REFERENCES auth_users(id),
 provider text NOT NULL CHECK(provider IN ('fixture','google','notion')),
 version integer NOT NULL CHECK(version > 0),
 status text NOT NULL CHECK(status IN ('connected','requires_authorization','expired','disconnected')),
 scopes text[] NOT NULL,
 resource_ids text[] NOT NULL,
 expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(provider = 'fixture' OR status IN ('requires_authorization','disconnected')),
 CHECK(provider <> 'fixture' OR (scopes <@ ARRAY['documents:read']::text[] AND resource_ids <@ ARRAY['doc-alpha','doc-beta']::text[])),
 CHECK(provider <> 'fixture' OR expires_at IS NOT NULL)
);
CREATE INDEX agent_connections_owner ON agent_connections(owner_id,updated_at DESC);
CREATE TABLE agent_connection_revisions (
 connection_id uuid NOT NULL REFERENCES agent_connections(id),
 version integer NOT NULL,
 owner_id text NOT NULL REFERENCES auth_users(id),
 provider text NOT NULL,
 status text NOT NULL,
 scopes text[] NOT NULL,
 resource_ids text[] NOT NULL,
 expires_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(connection_id,version)
);
CREATE FUNCTION reject_connection_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Connection generations are immutable';
END;
$$;
CREATE TRIGGER immutable_connection_revisions BEFORE UPDATE OR DELETE ON agent_connection_revisions FOR EACH ROW EXECUTE FUNCTION reject_connection_revision_mutation();
