-- Vaghinak (Վաղինակ), the AI Operations Deputy Director (see .claude/skills/KADDev/references/vaghinak-spec.md).
-- vaghinak_messages: everything he says or asks (reminders, questions, day wrap-ups, management briefs).
-- vaghinak_day_log: one row per rep per day with the facts he measured silently (start delay, office time, plan progress).
-- vaghinak_settings: thresholds management can tune (key -> JSON value).
CREATE TABLE vaghinak_messages (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  day DATE NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'nudge', 'important')),
  body TEXT NOT NULL,
  facts JSONB NOT NULL DEFAULT '{}',
  variant TEXT,
  -- a question the person must answer; mandatory = the app blocks until it is answered
  needs_answer BOOLEAN NOT NULL DEFAULT false,
  mandatory BOOLEAN NOT NULL DEFAULT false,
  choices JSONB,
  answer_choice TEXT,
  answer_text TEXT,
  answered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  reaction TEXT CHECK (reaction IN ('helpful', 'not_relevant')),
  -- shadow = recorded for management only (test mode): not shown to the person, no push
  shadow BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, kind, day, level)
);
CREATE INDEX vaghinak_messages_user_idx ON vaghinak_messages (user_id, created_at DESC);
CREATE INDEX vaghinak_messages_open_idx ON vaghinak_messages (user_id) WHERE needs_answer AND answered_at IS NULL;

CREATE TABLE vaghinak_day_log (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  first_checkin_at TIMESTAMPTZ,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  office_minutes INTEGER NOT NULL DEFAULT 0,
  planned_count INTEGER NOT NULL DEFAULT 0,
  visited_count INTEGER NOT NULL DEFAULT 0,
  last_checkin_at TIMESTAMPTZ,
  day_off BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);

CREATE TABLE vaghinak_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- How he addresses a person ("Արտակ ջան", "Պարոն Դավթյան") and a one-day mute (day off / sick).
ALTER TABLE users ADD COLUMN vaghinak_address TEXT;
ALTER TABLE users ADD COLUMN vaghinak_muted_day DATE;
