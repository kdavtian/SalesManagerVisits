-- Voice notes at a check-in (owner, 2026-11-12): the rep records a short audio note next to the photos; the server turns the Armenian speech into
-- text (OpenAI, when OPENAI_API_KEY is set) and shows both under the visit. Same visibility as the visit's photos.
CREATE TABLE IF NOT EXISTS checkin_voice_notes (
  id SERIAL PRIMARY KEY,
  checkin_id INTEGER NOT NULL REFERENCES checkins(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  mime TEXT NOT NULL,
  size_bytes INTEGER,
  duration_s INTEGER,
  -- pending -> done | failed; off = no speech service configured (the audio is kept, the text can be made later)
  transcript_status TEXT NOT NULL DEFAULT 'pending' CHECK (transcript_status IN ('pending', 'done', 'failed', 'off')),
  transcript TEXT,
  transcript_error TEXT,
  transcript_attempts INTEGER NOT NULL DEFAULT 0,
  transcribed_at TIMESTAMPTZ,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checkin_voice_notes_checkin_idx ON checkin_voice_notes (checkin_id);
