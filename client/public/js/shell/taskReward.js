// The "well done" moment (owner, 2026-11-08: "reward style confirmation when a task is completed, something motivating, maybe animation").
// A card slides up from the bottom with a drawn check mark, a little confetti and the person's numbers (done this week, what is left).
// It never blocks: tapping anywhere else keeps working, it leaves by itself after a few seconds.
// Two ways it appears:
//   - celebrateTask(): the person just finished a task by hand on this screen (the server already counted it as seen);
//   - the catch-up: tasks the SYSTEM finished (a payment, an order, a visit, a product check) or that finished on another device. The server
//     keeps them until this app has shown them once (GET /tasks/rewards, POST /tasks/rewards/seen), so nothing is lost when the app was
//     closed, offline or busy at the moment, and the same task is never celebrated twice.
import { api } from "../api.js";
import { t } from "../i18n.js";
import { state } from "../state.js";
import { rewardCard } from "./taskRewardMessages.js";

let card = null;
let hideTimer = 0;
let checking = false;
let lastCheck = 0;
let started = false;
const CONFETTI = ["#1f9d55", "#f5b301", "#e5383b", "#2f6fed", "#8e44ad", "#12b5a6"];

function reducedMotion() {
  return !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || document.documentElement.dataset.perf === "efficiency";
}

function confettiHtml() {
  if (reducedMotion()) return "";
  let out = "";
  for (let i = 0; i < 26; i++) {
    const x = Math.round((Math.random() - 0.5) * 300);
    const y = -Math.round(70 + Math.random() * 130);
    const r = Math.round(Math.random() * 540 - 270);
    const delay = Math.round(Math.random() * 120);
    out += `<i style="--x:${x}px;--y:${y}px;--r:${r}deg;--d:${delay}ms;background:${CONFETTI[i % CONFETTI.length]}"></i>`;
  }
  return `<div class="reward-confetti" aria-hidden="true">${out}</div>`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function fill(text, n) {
  return String(text).replace("{n}", n ?? "");
}

export function hideReward() {
  clearTimeout(hideTimer);
  if (!card) return;
  const el = card;
  card = null;
  el.classList.add("is-leaving");
  setTimeout(() => el.remove(), reducedMotion() ? 0 : 260);
}

// rewards: [{ id, title, task_kind, auto_kind, customer_name }]; stats: server numbers or null
export function showReward(rewards, stats = null) {
  if (!rewards.length) return;
  hideReward();
  const c = rewardCard(rewards, stats);
  const title = fill(t(c.titleKey), c.n);
  const who = c.names.length ? c.names.join(" · ") + (c.more ? ` +${c.more}` : "") : c.customer;
  const lines = c.lines.map((l) => `<span class="reward-chip">${esc(fill(t(l.key), l.n))}</span>`).join("");
  const el = document.createElement("div");
  el.className = `task-reward${c.big ? " is-big" : ""}`;
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `${confettiHtml()}
    <div class="reward-badge" aria-hidden="true"><svg viewBox="0 0 52 52" width="44" height="44"><circle class="reward-ring" cx="26" cy="26" r="23" fill="none"/><path class="reward-tick" d="M15 27l8 8 15-17" fill="none"/></svg></div>
    <div class="reward-body">
      <div class="reward-title">${esc(title)}</div>
      ${c.kindKey ? `<div class="reward-sub">${esc(t(c.kindKey))}${who ? ` · ${esc(who)}` : ""}</div>` : who ? `<div class="reward-sub">${esc(who)}</div>` : ""}
      ${lines ? `<div class="reward-chips">${lines}</div>` : ""}
    </div>
    <button type="button" class="reward-close" aria-label="${esc(t("close"))}">×</button>`;
  el.querySelector(".reward-close").addEventListener("click", hideReward);
  el.addEventListener("click", hideReward);
  document.body.appendChild(el);
  card = el;
  if (!reducedMotion()) navigator.vibrate?.(c.big ? [25, 40, 25] : 25);
  hideTimer = setTimeout(hideReward, c.big ? 6000 : 4500);
}

// The person finished a task by hand here: celebrate right away (a small server number is not worth a request before the card).
export async function celebrateTask(task) {
  // the numbers make the moment; wait for them at most 0.7 s, then show the card either way (once)
  const stats = await Promise.race([api.getTaskRewardStats().catch(() => null), new Promise((r) => setTimeout(() => r(null), 700))]);
  showReward([task], stats);
}

function busyTyping() {
  const a = document.activeElement;
  return !!a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable);
}

// One pending look at a time (a queue of offline writes flushing fires many events; they all collapse into one request)
let pending = 0;
function scheduleCheck(ms) {
  clearTimeout(pending);
  pending = setTimeout(() => checkRewards({ force: true }), ms);
}

// Ask the server whether tasks finished that this app has not celebrated yet.
export async function checkRewards({ force = false } = {}) {
  if (checking || !state.user || document.visibilityState === "hidden" || navigator.onLine === false) return;
  if (!force && Date.now() - lastCheck < 15000) return;
  if (busyTyping()) {
    scheduleCheck(4000); // not while someone types
    return;
  }
  checking = true;
  lastCheck = Date.now();
  try {
    const { rewards, stats } = await api.getTaskRewards();
    if (!rewards?.length) return;
    // claim first, show second: a failed mark means no card now (asked again later), never the same card over and over; and when another tab or
    // device claimed them in the same moment (marked 0), only that one shows it
    const claim = await api.markTaskRewardsSeen(rewards.map((r) => r.id));
    if (claim?.marked > 0) showReward(rewards, stats);
  } catch {
    // no signal or a server hiccup: the next check asks again, the tasks stay unseen on the server
  } finally {
    checking = false;
  }
}

// Called once after sign-in. Rewards are not for management who only watch tasks: the server returns only MY tasks, so everyone is safe.
export function startTaskRewards() {
  if (started) return;
  started = true;
  const soon = () => setTimeout(() => checkRewards(), 1200);
  setTimeout(() => checkRewards({ force: true }), 2500);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && soon());
  window.addEventListener("online", soon);
  // something that can finish a task just happened on this device (payment, order, check-in, product check): look right after
  window.addEventListener("fv:tasks-maybe-changed", () => scheduleCheck(1800));
  setInterval(() => checkRewards(), 90000);
}
