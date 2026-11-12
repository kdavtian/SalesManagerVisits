// Voice note at a check-in (owner, 2026-11-12): a microphone button next to "Take photo". Tap to record, tap again to stop (3 minutes at most);
// the recording can be played back and removed before the visit is saved. It travels with the check-in itself (field "voice_note"), so a
// visit saved without signal keeps its voice note in the offline queue too. The server turns the Armenian speech into text.
//
// iPhone Safari records MP4/AAC, Android Chrome WebM/Opus: the recorder takes the first type the browser supports. A browser with no
// MediaRecorder (very old phones) simply shows no button.
//
// Review 2026-11-12: Save while recording waits for the recording to finish (finish()); a second tap while the microphone opens does nothing;
// the Stop button is drawn once (only its clock changes, so a tap is never lost on a redrawn node); leaving the screen or hiding the app stops
// the recording and releases the microphone.
import { t } from "./i18n.js";
import { icons } from "./icons.js";

export const MAX_VOICE_SECONDS = 180;
const TYPES = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
const MIC_ICON = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>`;
const STOP_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>`;

export const voiceSupported = () => typeof window !== "undefined" && "MediaRecorder" in window && Boolean(navigator.mediaDevices?.getUserMedia);
const pickType = () => TYPES.find((type) => window.MediaRecorder.isTypeSupported?.(type)) ?? "";
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// Builds the button (and its preview) inside `slot`.
// Returns { recording(), finish(): Promise<recording>, reset(), dispose() } -- recording() = { blob, durationS, mime } | null.
export function mountVoiceRecorder(slot, { onChange } = {}) {
  if (!voiceSupported()) {
    slot.hidden = true;
    return { recording: () => null, finish: async () => null, reset() {}, dispose() {} };
  }
  let state = "idle"; // idle | starting | recording | stopping | done
  let recorder = null;
  let stream = null;
  let chunks = [];
  let startedAt = 0;
  let timer = null;
  let result = null; // { blob, durationS, mime, url }
  let stopped = null; // resolves when the current recording is turned into `result`
  let disposed = false;

  const render = () => {
    if (state === "recording" || state === "starting" || state === "stopping") {
      slot.innerHTML = `<button type="button" class="camera-btn voice-btn voice-btn-live" data-voice="stop" aria-label="${t("voice_stop")}" ${state === "recording" ? "" : "disabled"}>${STOP_ICON}<span class="voice-dot" aria-hidden="true"></span><span class="voice-clock">0:00 / ${clock(MAX_VOICE_SECONDS)}</span></button>`;
    } else if (result) {
      slot.innerHTML = `<div class="voice-preview">
          <audio controls preload="metadata" src="${result.url}"></audio>
          <button type="button" class="icon-btn" data-voice="remove" aria-label="${t("voice_remove")}">${icons.trash}</button>
        </div>`;
    } else {
      slot.innerHTML = `<button type="button" class="camera-btn voice-btn" data-voice="start" aria-label="${t("voice_record")}">${MIC_ICON}<span>${t("voice_record")}</span></button>`;
    }
  };
  // only the clock changes while recording: the button itself stays the same node
  const tick = () => {
    const el = slot.querySelector(".voice-clock");
    if (el) el.textContent = `${clock((Date.now() - startedAt) / 1000)} / ${clock(MAX_VOICE_SECONDS)}`;
  };

  const releaseMic = () => {
    clearInterval(timer);
    timer = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };

  async function start() {
    if (state !== "idle" || disposed) return; // a second tap while the microphone opens does nothing
    state = "starting";
    render();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      state = "idle";
      render();
      slot.insertAdjacentHTML("beforeend", `<p class="form-error voice-error">${t("voice_no_mic")}</p>`);
      return;
    }
    if (disposed) return releaseMic(); // the screen was left while the permission prompt was open
    const type = pickType();
    recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    chunks = [];
    let resolveStopped;
    stopped = new Promise((r) => (resolveStopped = r));
    recorder.addEventListener("dataavailable", (e) => e.data?.size && chunks.push(e.data));
    recorder.addEventListener("stop", () => {
      const mime = (recorder?.mimeType || type || "audio/webm").split(";")[0];
      const durationS = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      const blob = new Blob(chunks, { type: mime });
      recorder = null;
      releaseMic();
      result = blob.size && !disposed ? { blob, durationS, mime, url: URL.createObjectURL(blob) } : null;
      state = result ? "done" : "idle";
      if (!disposed) render();
      resolveStopped(result);
      onChange?.();
    });
    startedAt = Date.now();
    recorder.start(1000);
    state = "recording";
    render();
    timer = setInterval(() => {
      if ((Date.now() - startedAt) / 1000 >= MAX_VOICE_SECONDS) stop();
      else tick();
    }, 500);
  }

  function stop() {
    if (recorder && recorder.state !== "inactive") {
      state = "stopping";
      recorder.stop();
    }
  }

  // Save pressed: a recording still running is finished first, so it is not lost.
  async function finish() {
    if (state === "recording" || state === "stopping") {
      stop();
      await stopped;
    }
    return recording();
  }

  function recording() {
    return result ? { blob: result.blob, durationS: result.durationS, mime: result.mime } : null;
  }

  function reset() {
    stop();
    if (result?.url) URL.revokeObjectURL(result.url);
    result = null;
    state = "idle";
    render();
    onChange?.();
  }

  // The screen is gone: stop recording, free the microphone and the preview's memory.
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    releaseMic();
    if (result?.url) URL.revokeObjectURL(result.url);
    window.removeEventListener("hashchange", onLeave);
    window.removeEventListener("pagehide", onHide);
    document.removeEventListener("visibilitychange", onVisibility);
  }
  const onLeave = () => dispose();
  // the app sent to the background (another app, the screen locked): the recording so far is kept, the microphone is released
  const onHide = () => stop();
  const onVisibility = () => document.visibilityState === "hidden" && stop();
  window.addEventListener("hashchange", onLeave);
  window.addEventListener("pagehide", onHide);
  document.addEventListener("visibilitychange", onVisibility);

  slot.addEventListener("click", (e) => {
    const action = e.target.closest("[data-voice]")?.dataset.voice;
    slot.querySelector(".voice-error")?.remove();
    if (action === "start") start();
    else if (action === "stop") stop();
    else if (action === "remove") reset();
  });
  render();
  return { recording, finish, reset, dispose };
}

// The file name the upload uses: the extension tells the server (and the speech service) the container.
export const voiceFileName = (mime) => `voice-note.${mime === "audio/mp4" ? "m4a" : mime === "audio/ogg" ? "ogg" : "webm"}`;
