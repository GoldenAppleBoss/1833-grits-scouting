-- Private server configuration, never exposed through the browser Data API.
CREATE TABLE IF NOT EXISTS shared_login.service_settings (
  name text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE shared_login.service_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON shared_login.service_settings FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON shared_login.service_settings FROM anon,authenticated;
  END IF;
END $$;
