-- Official results are a replaceable snapshot. Deletions keep a private audit and
-- a permanent ID tombstone so an old offline device cannot restore a bad entry.
CREATE TABLE scouting.event_scores (
  event_key text PRIMARY KEY REFERENCES scouting.events(event_key) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE scouting.deleted_records (
  record_id text PRIMARY KEY,
  owner_user_id bigint NOT NULL REFERENCES shared_login.portal_users(id),
  event_key text NOT NULL,
  match_key text NOT NULL,
  team_number integer NOT NULL,
  payload jsonb NOT NULL,
  reason text NOT NULL,
  deleted_by bigint NOT NULL REFERENCES shared_login.portal_users(id),
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deleted_records_event ON scouting.deleted_records(event_key);
ALTER TABLE scouting.event_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE scouting.deleted_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON scouting.event_scores, scouting.deleted_records FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON scouting.event_scores, scouting.deleted_records FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON scouting.event_scores, scouting.deleted_records FROM authenticated;
  END IF;
END $$;
