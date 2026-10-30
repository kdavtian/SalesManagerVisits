// Renders the CEO-bot mock (bot.html -> ../screenshots/raw/bot.png) and the slide icons (the app's own lucide-style icons -> icons/*.png).
// Needs the local demo app running (icons are read from its /js/icons.js).   Run: node assets.mjs
const { chromium } = await import(process.env.PLAYWRIGHT ?? new URL("../../../server/node_modules/playwright/index.mjs", import.meta.url).pathname);
const D = new URL("./", import.meta.url).pathname;
const BASE = process.env.DECK_BASE ?? "http://127.0.0.1:3201";
const browser = await chromium.launch();
// bot mock
{ const p = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
  await p.goto("file://" + D + "bot.html"); await p.waitForTimeout(400); await p.screenshot({ path: D + "../screenshots/raw/bot.png" }); }
// icons from the app's own set (+ a camera and a spreadsheet glyph in the same style)
{ const p = await browser.newPage({ viewport: { width: 400, height: 400 } });
  await p.goto(BASE + "/");
  const extra = {
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/></svg>',
    sheet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h8M12 11v8"/></svg>',
    smartphone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M11 18h2"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
    database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
    wifioff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l20 20"/><path d="M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 4.3-2.5M19 12.9a10 10 0 0 0-2.4-1.7M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 10.7 5"/><path d="M12 20h.01"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    signature: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c3-4 5-9 7-9s-1 9 1 9 3-4 4-4 1 3 3 3 2-1 3-1"/><path d="M3 21h18"/></svg>',
    bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 14h.01M15 14h.01M2 13v3M22 13v3"/><circle cx="12" cy="3.5" r="1"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>',
    handshake: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m11 17 2 2a1 1 0 0 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 0 0 3-3l-3.9-3.9a3 3 0 0 0-4.2 0l-.9.9a1 1 0 0 1-3-3l2.8-2.8a5.8 5.8 0 0 1 7 .9L21 7"/><path d="m21 3 1 11h-2M3 3 2 14l6.5 6.5a1 1 0 0 0 3-3M3 4h8"/></svg>',
    layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/></svg>',
  };
  const names = ["mapPinCheck","map","customers","cart","tag","wallet","payment","gift","target","chart","gauge","trendUp","team","truck","box","sparkles","vaghinak","shield","person","phone","clock","mapWarning","store","send","repeat","dashboard","folder","tasks","route","checkCircle","warning","calendar","clipboardCheck","history"];
  const colors = { g: "#009343", r: "#E2001A", k: "#2B2F33", w: "#FFFFFF" };
  const out = await p.evaluate(async ({ names, extra, colors }) => {
    const mod = await import("/js/icons.js"); const icons = mod.icons ?? mod.default ?? mod;
    const res = {};
    for (const n of [...names, ...Object.keys(extra)]) {
      const svg = extra[n] ?? icons[n]; if (!svg) { res[n] = null; continue; }
      res[n] = svg;
    }
    return res;
  }, { names, extra, colors });
  for (const [n, svg] of Object.entries(out)) {
    if (!svg) { console.log("missing", n); continue; }
    for (const [ck, col] of Object.entries(colors)) {
      await p.setContent(`<html><body style="margin:0;background:transparent"><div id=i style="width:192px;height:192px;color:${col};display:flex">${svg.replace(/<svg[^>]*>/, (m) => m.replace(/\swidth="\d+"/, "").replace(/\sheight="\d+"/, "").replace("<svg ", '<svg style="width:192px;height:192px" '))}</div></body></html>`);
      await p.locator("#i").screenshot({ path: `${D}icons/${n}_${ck}.png`, omitBackground: true });
    }
  }
}
await browser.close();
console.log("assets done");
