CREATE TABLE daily_lessons (
  user_id uuid NOT NULL,
  mode text NOT NULL CHECK (mode IN ('archive', 'demo')),
  id text NOT NULL CHECK (id ~ '^daily-[a-f0-9]{40}$'),
  attempt_id text NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 200),
  version integer NOT NULL CHECK (version > 0),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, mode, id),
  UNIQUE (user_id, mode, attempt_id)
);
CREATE INDEX daily_lessons_recent_idx ON daily_lessons(user_id, mode, created_at DESC);
ALTER TABLE daily_lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_lessons FORCE ROW LEVEL SECURITY;
CREATE POLICY user_isolation ON daily_lessons
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
