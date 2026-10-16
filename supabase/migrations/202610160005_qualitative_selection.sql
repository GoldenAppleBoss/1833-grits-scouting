CREATE TABLE scouting.team_notes (
  id uuid PRIMARY KEY, event_key text NOT NULL REFERENCES scouting.events(event_key),
  team_number integer NOT NULL, match_key text, owner_user_id bigint NOT NULL REFERENCES shared_login.portal_users(id),
  payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX team_notes_event ON scouting.team_notes(event_key,team_number,created_at);
CREATE TABLE scouting.selection_workspaces (
  event_key text PRIMARY KEY REFERENCES scouting.events(event_key), revision bigint NOT NULL DEFAULT 0,
  payload jsonb NOT NULL, updated_by bigint REFERENCES shared_login.portal_users(id), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE scouting.selection_changes (
  id uuid PRIMARY KEY, event_key text NOT NULL REFERENCES scouting.events(event_key),
  revision bigint NOT NULL, actor_id bigint NOT NULL REFERENCES shared_login.portal_users(id),
  request jsonb NOT NULL, before_payload jsonb NOT NULL, description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(event_key,revision)
);
CREATE INDEX selection_changes_event ON scouting.selection_changes(event_key,revision DESC);
CREATE TABLE scouting.selection_presence (
  event_key text NOT NULL REFERENCES scouting.events(event_key), user_id bigint NOT NULL REFERENCES shared_login.portal_users(id),
  last_seen timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(event_key,user_id)
);
ALTER TABLE scouting.team_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE scouting.selection_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE scouting.selection_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE scouting.selection_presence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON scouting.team_notes,scouting.selection_workspaces,scouting.selection_changes,scouting.selection_presence FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON scouting.team_notes,scouting.selection_workspaces,scouting.selection_changes,scouting.selection_presence FROM %I',role_name);
    END IF;
  END LOOP;
END $$;
