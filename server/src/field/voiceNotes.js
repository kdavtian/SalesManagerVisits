// Voice notes at a check-in (owner, 2026-11-12): the rep records what was said at the customer instead of typing it; the server turns the
// Armenian speech into text. Speech-to-text is OpenAI's transcription API (the owner's choice: good Armenian, about $0.006 per minute); it runs
// only when OPENAI_API_KEY is set on the server -- without it the audio is still kept and played back, and the text says it is not made.
// The audio leaves the server only to that service (the owner accepted it for this demo).
import fs from "node:fs";
import path from "node:path";
import { pool } from "../db/pool.js";
import { uploadDirPath } from "../shared/upload.js";

export const MAX_VOICE_SECONDS = 180;
const API_URL = "https://api.openai.com/v1/audio/transcriptions";
export const TRANSCRIBE_MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe";
export const isSpeechConfigured = () => Boolean(process.env.OPENAI_API_KEY);

// Sends one stored note to the speech service and saves the text. `fetchImpl` can be injected (tests). Never throws.
export async function transcribeVoiceNote(noteId, { db = pool, fetchImpl = globalThis.fetch, apiKey = process.env.OPENAI_API_KEY } = {}) {
  const { rows } = await db.query("SELECT id, file_path, mime FROM checkin_voice_notes WHERE id = $1", [noteId]);
  const note = rows[0];
  if (!note) return null;
  if (!apiKey) {
    await db.query("UPDATE checkin_voice_notes SET transcript_status = 'off' WHERE id = $1 AND transcript_status = 'pending'", [note.id]);
    return { status: "off" };
  }
  await db.query("UPDATE checkin_voice_notes SET transcript_status = 'pending', transcript_attempts = transcript_attempts + 1, transcribed_at = now() WHERE id = $1", [note.id]);
  try {
    // streamed from disk (not read into memory first)
    const file = await fs.openAsBlob(path.join(uploadDirPath, note.file_path), { type: note.mime });
    const form = new FormData();
    // the file name's extension tells the service the container (webm, m4a, mp3 ...)
    form.append("file", file, path.basename(note.file_path));
    form.append("model", TRANSCRIBE_MODEL);
    form.append("language", "hy");
    form.append("response_format", "json");
    const res = await fetchImpl(API_URL, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new Error(`speech service answered ${res.status}`);
    const data = await res.json();
    const text = String(data?.text ?? "").trim();
    await db.query("UPDATE checkin_voice_notes SET transcript_status = 'done', transcript = $2, transcript_error = NULL, transcribed_at = now() WHERE id = $1", [note.id, text]);
    return { status: "done", text };
  } catch (err) {
    // The key or the audio never goes into the log line: only what failed.
    console.error("Voice note transcription failed:", err.message);
    await db.query("UPDATE checkin_voice_notes SET transcript_status = 'failed', transcript_error = $2 WHERE id = $1", [note.id, String(err.message).slice(0, 200)]);
    return { status: "failed" };
  }
}

// Fire-and-forget after the check-in is saved: never delays the answer. At most 2 at a time (a phone flushing its offline queue sends several).
const queue = [];
let running = 0;
export function scheduleTranscription(noteId) {
  queue.push(noteId);
  pump();
}
function pump() {
  while (running < 2 && queue.length) {
    const id = queue.shift();
    running++;
    transcribeVoiceNote(id)
      .catch((err) => console.error("Voice note transcription failed:", err.message))
      .finally(() => {
        running--;
        pump();
      });
  }
}

// Retry round (from the ops jobs): a note left "pending" by a restart, a "failed" one (3 tries at most, an hour apart), and an "off" one once
// the key is set (the text can be made later). A few per run.
export async function retryTranscriptions({ db = pool, limit = 10 } = {}) {
  if (!isSpeechConfigured()) return 0;
  const { rows } = await db.query(
    `SELECT id FROM checkin_voice_notes
     WHERE created_at > now() - interval '30 days' AND transcript_attempts < 3
       AND (transcript_status = 'off'
            OR (transcript_status = 'pending' AND COALESCE(transcribed_at, created_at) < now() - interval '10 minutes')
            OR (transcript_status = 'failed' AND COALESCE(transcribed_at, created_at) < now() - interval '1 hour'))
     ORDER BY id LIMIT $1`,
    [limit]
  );
  rows.forEach((r) => scheduleTranscription(r.id));
  return rows.length;
}

// The voice notes of a list of check-ins, for the visit sheet (no audio bytes: the sheet plays them from the audio route).
export const VOICE_NOTES_JSON_SQL = `COALESCE((SELECT json_agg(json_build_object('id', vn.id, 'duration_s', vn.duration_s, 'transcript_status', vn.transcript_status,
  'transcript', vn.transcript) ORDER BY vn.id) FROM checkin_voice_notes vn WHERE vn.checkin_id = ch.id), '[]')`;
