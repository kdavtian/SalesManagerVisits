// Voice notes at a check-in (owner, 2026-11-12): the audio travels with the check-in, is checked by its bytes, is heard only by the people who
// see the visit, and its Armenian text comes from the speech service (faked here: the live call needs OPENAI_API_KEY).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startTestServer, stopTestServer, cleanupAll, createUser, createCustomer, loginAs, apiRequest } from "./helpers.js";
import { pool } from "../../src/db/pool.js";
import { uploadDirPath } from "../../src/shared/upload.js";
import { transcribeVoiceNote } from "../../src/field/voiceNotes.js";

let port;
const checkinIds = [];
test.before(async () => {
  port = new URL(await startTestServer()).port;
});
test.after(async () => {
  const { rows } = await pool.query("SELECT file_path FROM checkin_voice_notes WHERE checkin_id = ANY($1)", [checkinIds]);
  for (const r of rows) fs.rmSync(path.join(uploadDirPath, r.file_path), { force: true });
  await pool.query("DELETE FROM checkins WHERE id = ANY($1)", [checkinIds]);
  await cleanupAll();
  await stopTestServer();
});

// the first bytes of a WebM (EBML) file, then filler: enough for the byte check
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 1)]);

async function postCheckin(cookie, customer, audio, { type = "audio/webm", name = "voice-note.webm", duration = "12" } = {}) {
  const form = new FormData();
  form.set("customer_id", String(customer.id));
  form.set("lat", "40.18");
  form.set("lng", "44.51");
  form.set("outcomes", JSON.stringify(["no_order"]));
  form.set("client_ref", `itest-voice-${Date.now()}-${Math.random()}`);
  if (audio) {
    form.append("voice_note", new Blob([audio], { type }), name);
    form.set("voice_duration_s", duration);
  }
  const csrf = cookie.match(/(?:^|; )csrf_token=([^;]+)/)?.[1];
  const res = await fetch(`http://127.0.0.1:${port}/api/checkins`, { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrf }, body: form });
  const data = await res.json();
  if (data?.id) checkinIds.push(data.id);
  return { status: res.status, data };
}

test("a check-in carries a voice note; a file that is not audio is refused; the text is made by the speech service", async () => {
  const rep = await createUser("sales_manager");
  const customer = await createCustomer({ created_by: rep.id, assigned_manager_id: rep.id });
  const cookie = await loginAs(rep.email);

  // a recording that is not audio is left out -- the visit itself is still saved (a refused queued visit would be dropped with its money)
  const bad = await postCheckin(cookie, customer, Buffer.from("not audio at all"), { type: "audio/webm" });
  assert.equal(bad.status, 201, JSON.stringify(bad.data));
  assert.equal(bad.data.voice_note_rejected, true);
  assert.equal(bad.data.voice_note_count, undefined);
  const notAudioType = await postCheckin(cookie, customer, WEBM, { type: "application/pdf", name: "x.pdf" });
  assert.equal(notAudioType.status, 201);
  assert.equal(notAudioType.data.voice_note_rejected, true);
  // declared webm, really MP4: stored as what it is (Safari plays it, the speech service gets the right extension)
  const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypM4A "), Buffer.alloc(200, 2)]);
  const mislabelled = await postCheckin(cookie, customer, MP4, { type: "audio/webm" });
  assert.equal(mislabelled.status, 201);
  const { rows: [m] } = await pool.query("SELECT mime, file_path FROM checkin_voice_notes WHERE checkin_id = $1", [mislabelled.data.id]);
  assert.equal(m.mime, "audio/mp4");
  assert.match(m.file_path, /\.m4a$/);
  assert.ok(fs.existsSync(path.join(uploadDirPath, m.file_path)));

  const ok = await postCheckin(cookie, customer, WEBM, { duration: "999" });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.voice_note_count, 1);
  const { rows: [note] } = await pool.query("SELECT * FROM checkin_voice_notes WHERE checkin_id = $1", [ok.data.id]);
  assert.equal(note.mime, "audio/webm");
  assert.equal(note.duration_s, 180, "capped at 3 minutes");
  assert.ok(fs.existsSync(path.join(uploadDirPath, note.file_path)));

  // no key on the server: kept as audio, the text says it is not made
  assert.deepEqual(await transcribeVoiceNote(note.id, { apiKey: "" }), { status: "off" });
  // the speech service answers: Armenian, the right model, the file with its extension
  let sent = null;
  const fakeFetch = async (url, init) => {
    sent = { url, lang: init.body.get("language"), model: init.body.get("model"), file: init.body.get("file"), auth: init.headers.Authorization };
    return { ok: true, json: async () => ({ text: "Հաճախորդը խնդրեց հաջորդ շաբաթ գալ։" }) };
  };
  await pool.query("UPDATE checkin_voice_notes SET transcript_status = 'pending' WHERE id = $1", [note.id]);
  const done = await transcribeVoiceNote(note.id, { apiKey: "test-key", fetchImpl: fakeFetch });
  assert.equal(done.status, "done");
  assert.equal(sent.url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(sent.lang, "hy");
  assert.ok(sent.model);
  assert.match(sent.file.name, /\.webm$/);
  assert.equal(sent.auth, "Bearer test-key");
  // a failing service: "failed", never a crash
  const failed = await transcribeVoiceNote(note.id, { apiKey: "k", fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(failed.status, "failed");
  await transcribeVoiceNote(note.id, { apiKey: "test-key", fetchImpl: fakeFetch });

  // the visit list carries it with its text
  const list = await apiRequest(`/api/checkins?customer_id=${customer.id}`, { cookie });
  const row = list.data.rows.find((r) => r.id === ok.data.id);
  assert.equal(row.voice_notes.length, 1);
  assert.equal(row.voice_notes[0].transcript, "Հաճախորդը խնդրեց հաջորդ շաբաթ գալ։");

  // who may listen: the rep who recorded it and those who see all activity; another rep gets 403
  const audioUrl = `/api/checkins/voice-notes/${note.id}/audio`;
  const own = await fetch(`http://127.0.0.1:${port}${audioUrl}`, { headers: { Cookie: cookie } });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get("content-type"), "audio/webm");
  const other = await createUser("sales_manager");
  assert.equal((await apiRequest(audioUrl, { cookie: await loginAs(other.email) })).status, 403);
  const director = await createUser("sales_director");
  const dir = await fetch(`http://127.0.0.1:${port}${audioUrl}`, { headers: { Cookie: await loginAs(director.email) } });
  assert.equal(dir.status, 200);
  assert.equal((await apiRequest("/api/checkins/voice-notes/abc/audio", { cookie })).status, 404);
});
