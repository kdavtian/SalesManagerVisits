// Two versions of the app's scripts met in one page (owner, 2026-11-07: after an update Customers showed "null is not an object (evaluating
// 'qe.user.role')" and Orders "The screen did not open"). A page started on the old scripts, the update took over, and a screen opened for the
// first time came from the NEW files: it got its own empty copy of the app's state (nobody signed in) while the page still held the old one.
// state.js now shares ONE state through the page (so a mixed screen still knows who is signed in) and calls this when it sees the mix, so the
// app starts clean on the new version by itself instead of showing an error. At most once a minute, so it can never loop.
// No imports on purpose: it runs while the app's own modules are still loading.
export function reloadOnVersionMix(reason) {
  try {
    const last = Number(sessionStorage.getItem("fv_mix_reload") || 0);
    if (Date.now() - last < 60000) return false;
    sessionStorage.setItem("fv_mix_reload", String(Date.now()));
  } catch {
    // no sessionStorage: reload anyway (the stored files are cleared below, so a second mix is not expected)
  }
  console.warn(`Two versions of the app met (${reason}): starting clean on the new one`);
  const clearing = (async () => {
    const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
    await Promise.all(regs.map((r) => r.unregister()));
    const keys = (await globalThis.caches?.keys?.()) ?? [];
    await Promise.all(keys.map((k) => caches.delete(k)));
  })().catch(() => {});
  Promise.race([clearing, new Promise((resolve) => setTimeout(resolve, 3000))]).then(() => {
    // the same clean start as slowRoute.js cleanReload(): a new address, answered by the server (not by a stored page)
    location.replace(`${location.pathname}?fv_retry=${Date.now()}${location.hash}`);
  });
  return true;
}
