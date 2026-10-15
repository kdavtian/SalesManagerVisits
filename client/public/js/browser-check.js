// "Please update your browser" screen. Classic (non-module) ES5 script on
// purpose: it must run, and draw something readable, in exactly the old
// browsers the rest of the app (ES modules, optional chaining, :has(),
// dvh, color-mix) cannot start in -- otherwise the user just sees a blank
// page. Same-origin file (not inline) because of the strict script-src CSP.
//
// Two levels:
//  - HARD: a feature the app really needs is missing (service worker,
//    IndexedDB, crypto.randomUUID for order ids, :has(), dvh units, ES
//    modules). The screen covers the app and bootGate.js does not boot it.
//    A small "Open anyway" link lets the user try for this session, so a
//    wrong detection can never lock a rep out.
//  - SOFT: only color-mix() is missing (iOS 15.4-16.1, Chrome 105-110). The
//    app works but tints look flat; a one-time notice with "Continue".
(function () {
  var SOFT_KEY = "fieldvisits_old_browser_ok";
  var HARD_KEY = "fieldvisits_old_browser_open";

  function supports(decl, val) {
    try {
      return !!(window.CSS && CSS.supports && (val === undefined ? CSS.supports(decl) : CSS.supports(decl, val)));
    } catch (e) {
      return false;
    }
  }

  var hard = false;
  try {
    hard =
      !("noModule" in HTMLScriptElement.prototype) ||
      !("serviceWorker" in navigator) ||
      !window.indexedDB ||
      !window.Promise ||
      !window.fetch ||
      !(window.crypto && typeof window.crypto.randomUUID === "function") ||
      !supports("selector(:has(*))") ||
      !supports("height", "1dvh");
  } catch (e) {
    hard = true;
  }
  var soft = !hard && !supports("color", "color-mix(in srgb, red, blue)");
  if (!hard && !soft) return;

  function stored(storage, key) {
    try {
      return window[storage].getItem(key) === "1";
    } catch (e) {
      return false;
    }
  }
  function store(storage, key) {
    try {
      window[storage].setItem(key, "1");
    } catch (e) {}
  }
  if (hard && stored("sessionStorage", HARD_KEY)) return;
  if (soft && stored("localStorage", SOFT_KEY)) return;
  if (hard) window.__fvBrowserBlocked = true;

  var lang = "hy";
  try {
    if (localStorage.getItem("fieldvisits_lang") === "en") lang = "en";
  } catch (e) {}
  var ua = navigator.userAgent || "";
  var platform = /iPhone|iPad|iPod/.test(ua) ? "ios" : /Android/.test(ua) ? "android" : "other";

  var T = {
    hy: {
      title: "Խնդրում ենք թարմացնել բրաուզերը",
      hard: "Այս հեռախոսի բրաուզերը շատ հին է, և հավելվածը կարող է չաշխատել։",
      soft: "Հավելվածը կաշխատի, բայց որոշ գույներ ու նկարներ կարող են այլ տեսք ունենալ։ Թարմացրեք, երբ հնարավոր լինի։",
      ios: "iPhone-ում՝ Կարգավորումներ → Ընդհանուր → Ծրագրի թարմացում։ Պետք է iOS 16.4 կամ ավելի նոր տարբերակ։",
      android: "Android-ում՝ Play Store → Chrome → Թարմացնել։ Պետք է Chrome 111 կամ ավելի նոր տարբերակ։",
      other: "Թարմացրեք բրաուզերը (iPhone՝ iOS 16.4+, Android՝ Chrome 111+) կամ բացեք հավելվածը այլ հեռախոսից։",
      cont: "Շարունակել",
      anyway: "Բացել միևնույն է",
    },
    en: {
      title: "Please update your browser",
      hard: "The browser on this phone is too old, so the app may not work.",
      soft: "The app will work, but some colours and shapes may look different. Please update when you can.",
      ios: "On iPhone: Settings → General → Software Update. You need iOS 16.4 or newer.",
      android: "On Android: Play Store → Chrome → Update. You need Chrome 111 or newer.",
      other: "Update your browser (iPhone: iOS 16.4+, Android: Chrome 111+) or open the app on another phone.",
      cont: "Continue",
      anyway: "Open anyway",
    },
  }[lang];

  var dark = false;
  try {
    dark = localStorage.getItem("fieldvisits_theme") === "dark";
  } catch (e) {}

  function el(tag, css, text) {
    var n = document.createElement(tag);
    n.style.cssText = css;
    if (text) n.textContent = text;
    return n;
  }

  function show() {
    var box = el(
      "div",
      "position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;display:flex;" +
        "flex-direction:column;align-items:center;justify-content:center;text-align:center;" +
        "padding:24px 28px;box-sizing:border-box;overflow:auto;" +
        "font:16px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
        (dark ? "background:#14161a;color:#f1f2f4;" : "background:#f6f7f9;color:#1b1d21;")
    );
    box.setAttribute("role", "alertdialog");
    var icon = el(
      "div",
      "width:64px;height:64px;border-radius:16px;background:#2563eb;color:#fff;font-size:34px;" +
        "line-height:64px;font-weight:700;margin-bottom:18px;",
      "↑"
    );
    box.appendChild(icon);
    box.appendChild(el("h1", "font-size:21px;line-height:1.25;margin:0 0 10px;font-weight:700;", T.title));
    box.appendChild(el("p", "margin:0 0 14px;max-width:340px;", hard ? T.hard : T.soft));
    box.appendChild(el("p", "margin:0 0 22px;max-width:340px;opacity:.8;font-size:15px;", T[platform]));

    var btn = el(
      "button",
      "min-height:48px;min-width:200px;padding:0 24px;border:0;border-radius:12px;font-size:16px;" +
        "font-weight:600;background:#2563eb;color:#fff;cursor:pointer;",
      hard ? null : T.cont
    );
    if (hard) {
      btn.textContent = T.anyway;
      btn.style.cssText =
        "min-height:44px;padding:0 16px;border:0;background:transparent;font-size:15px;" +
        "color:inherit;opacity:.65;text-decoration:underline;cursor:pointer;";
    }
    btn.type = "button";
    btn.onclick = function () {
      if (hard) {
        store("sessionStorage", HARD_KEY);
        window.location.reload();
      } else {
        store("localStorage", SOFT_KEY);
        if (box.parentNode) box.parentNode.removeChild(box);
      }
    };
    box.appendChild(btn);
    document.body.appendChild(box);
  }

  if (document.body) show();
  else document.addEventListener("DOMContentLoaded", show);
})();
