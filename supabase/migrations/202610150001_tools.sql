-- Private schemas: Vercel accesses PostgreSQL directly; browser Data API access is denied.
CREATE SCHEMA IF NOT EXISTS shared_login;
CREATE SCHEMA IF NOT EXISTS scouting;
CREATE TABLE IF NOT EXISTS shared_login.portal_users (
    id bigserial PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL,
    is_active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shared_login.portal_permissions (
    user_id bigint NOT NULL REFERENCES shared_login.portal_users(id) ON DELETE CASCADE,
    permission text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,permission)
);
CREATE TABLE IF NOT EXISTS shared_login.portal_sessions (
    token_hash bytea PRIMARY KEY, user_id bigint NOT NULL REFERENCES shared_login.portal_users(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portal_sessions_expiry_idx ON shared_login.portal_sessions(expires_at);
CREATE TABLE IF NOT EXISTS shared_login.auth_attempts (key text PRIMARY KEY, window_start timestamptz NOT NULL, attempts integer NOT NULL);
CREATE TABLE IF NOT EXISTS scouting.records (
    record_id text PRIMARY KEY, owner_user_id bigint NOT NULL REFERENCES shared_login.portal_users(id),
    match_number integer NOT NULL CHECK(match_number>0), team_number integer NOT NULL CHECK(team_number>0),
    revision integer NOT NULL CHECK(revision>0), completed boolean NOT NULL DEFAULT false,
    payload jsonb NOT NULL, server_received_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE scouting.records ADD COLUMN IF NOT EXISTS event_key text;
ALTER TABLE scouting.records ADD COLUMN IF NOT EXISTS match_key text;
ALTER TABLE scouting.records ADD COLUMN IF NOT EXISTS kind text;
UPDATE scouting.records SET event_key=COALESCE(NULLIF(payload->>'eventKey',''),'legacy') WHERE event_key IS NULL;
UPDATE scouting.records SET match_key=COALESCE(NULLIF(payload->>'matchKey',''),'qm'||match_number::text) WHERE match_key IS NULL;
UPDATE scouting.records SET kind='quantitative' WHERE kind IS NULL;
ALTER TABLE scouting.records ALTER COLUMN event_key SET NOT NULL;
ALTER TABLE scouting.records ALTER COLUMN match_key SET NOT NULL;
ALTER TABLE scouting.records ALTER COLUMN kind SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS records_completed_event_scout_match_team_kind ON scouting.records(owner_user_id,event_key,match_key,team_number,kind) WHERE completed;
DROP INDEX IF EXISTS scouting.records_completed_scout_match_team;
CREATE INDEX IF NOT EXISTS records_event_idx ON scouting.records(event_key,kind,completed);
CREATE TABLE IF NOT EXISTS scouting.events (
    event_key text PRIMARY KEY, name text NOT NULL, year integer NOT NULL DEFAULT 2026 CHECK(year=2026),
    imported_at timestamptz, imported_by bigint REFERENCES shared_login.portal_users(id)
);
CREATE TABLE IF NOT EXISTS scouting.teams (
    event_key text NOT NULL REFERENCES scouting.events(event_key), team_number integer NOT NULL,
    name text NOT NULL, PRIMARY KEY(event_key,team_number)
);
CREATE TABLE IF NOT EXISTS scouting.matches (
    event_key text NOT NULL REFERENCES scouting.events(event_key), match_key text NOT NULL,
    match_number integer NOT NULL, comp_level text NOT NULL, set_number integer NOT NULL DEFAULT 1,
    scheduled_time bigint, red integer[] NOT NULL, blue integer[] NOT NULL,
    PRIMARY KEY(event_key,match_key)
);
CREATE TABLE IF NOT EXISTS scouting.rotations (
    event_key text NOT NULL REFERENCES scouting.events(event_key), user_id bigint NOT NULL REFERENCES shared_login.portal_users(id),
    rotation integer NOT NULL CHECK(rotation>0), rotation_count integer NOT NULL CHECK(rotation_count>0 AND rotation_count<=100),
    alliance text NOT NULL CHECK(alliance IN ('red','blue')), station integer NOT NULL CHECK(station BETWEEN 1 AND 3),
    PRIMARY KEY(event_key,user_id), CHECK(rotation<=rotation_count), UNIQUE(event_key,rotation,alliance,station)
);
CREATE TABLE IF NOT EXISTS scouting.alliances (
    event_key text NOT NULL REFERENCES scouting.events(event_key), id uuid NOT NULL,
    name text NOT NULL, teams integer[] NOT NULL, strategy text NOT NULL DEFAULT '',
    created_by bigint NOT NULL REFERENCES shared_login.portal_users(id), updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(event_key,id), CHECK(cardinality(teams) BETWEEN 1 AND 3)
);
-- Defense in depth if a project later exposes one of these schemas via PostgREST.
ALTER TABLE shared_login.portal_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_login.portal_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_login.portal_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_login.auth_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE scouting.records ENABLE ROW LEVEL SECURITY;
ALTER TABLE scouting.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE scouting.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE scouting.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE scouting.rotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE scouting.alliances ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA shared_login,scouting FROM PUBLIC;
-- Supabase anon/authenticated roles must not receive the server's privileges.
DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
        REVOKE ALL ON SCHEMA shared_login,scouting FROM anon,authenticated;
        REVOKE ALL ON ALL TABLES IN SCHEMA shared_login,scouting FROM anon,authenticated;
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA shared_login,scouting FROM anon,authenticated;
    END IF;
END $$;
