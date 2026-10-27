CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  rolled_back_at timestamptz
);
CREATE TABLE IF NOT EXISTS schema_migration_events (
  id bigserial PRIMARY KEY,
  version integer NOT NULL,
  direction text NOT NULL CHECK (direction IN ('up', 'down')),
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE drafts (
  user_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('archive', 'demo')),
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 500),
  value jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  deleted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mode, id)
);
CREATE TABLE notes (LIKE drafts INCLUDING ALL);
CREATE TABLE bookmarks (LIKE drafts INCLUDING ALL);
CREATE TABLE settings (LIKE drafts INCLUDING ALL);
CREATE TABLE practice_sessions (LIKE drafts INCLUDING ALL);
CREATE TABLE attempts (
  user_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('archive', 'demo')),
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 200),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mode, id)
);
CREATE INDEX attempts_recent_idx ON attempts (user_id, mode, created_at DESC);
CREATE TABLE recordings (
  user_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('archive', 'demo')),
  id uuid NOT NULL,
  item_id text NOT NULL CHECK (length(item_id) BETWEEN 1 AND 200),
  question integer NOT NULL CHECK (question >= 0),
  duration_seconds double precision NOT NULL CHECK (duration_seconds >= 0 AND duration_seconds < 'Infinity'::float8),
  content_type text NOT NULL,
  size bigint NOT NULL CHECK (size > 0 AND size <= 33554432),
  filename text NOT NULL UNIQUE CHECK (filename ~ '^[a-f0-9-]{36}\.(webm|ogg|mp4|m4a|wav|mp3)$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mode, id)
);
CREATE INDEX recordings_item_idx ON recordings (user_id, mode, item_id, created_at DESC);
CREATE TABLE library_items (
  mode text NOT NULL CHECK (mode IN ('archive', 'demo')),
  id text NOT NULL,
  metadata jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mode, id)
);
CREATE TABLE library_papers (LIKE library_items INCLUDING ALL);

DO $$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['drafts','notes','bookmarks','settings','practice_sessions','attempts','recordings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format('CREATE POLICY user_isolation ON %I USING (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid) WITH CHECK (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)', tab);
  END LOOP;
END $$;
