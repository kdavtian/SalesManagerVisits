import { state } from "./state.js";
import { getLang } from "./i18n.js";
import { APP_VERSION } from "./version.js";

const HY_REGION = {
  Yerevan: "Երևան",
  Aragatsotn: "Արագածոտն",
  Ararat: "Արարատ",
  Armavir: "Արմավիր",
  Gegharkunik: "Գեղարքունիք",
  Kotayk: "Կոտայք",
  Lori: "Լոռի",
  Shirak: "Շիրակ",
  Syunik: "Սյունիք",
  Tavush: "Տավուշ",
  "Vayots Dzor": "Վայոց ձոր",
  Ajapnyak: "Աջափնյակ",
  Arabkir: "Արաբկիր",
  Avan: "Ավան",
  Davtashen: "Դավթաշեն",
  Erebuni: "Էրեբունի",
  "Kanaker-Zeytun": "Քանաքեռ-Զեյթուն",
  Kentron: "Կենտրոն",
  "Malatia-Sebastia": "Մալաթիա-Սեբաստիա",
  "Nor Nork": "Նոր Նորք",
  "Nork-Marash": "Նորք-Մարաշ",
  Nubarashen: "Նուբարաշեն",
  Shengavit: "Շենգավիթ",
};

function localizeRegionControls(root = document) {
  if (getLang() !== "hy") return;

  root.querySelectorAll("select option").forEach((option) => {
    const key = option.value || option.textContent.trim();
    const next = HY_REGION[key];
    if (next && option.textContent !== next) option.textContent = next;
  });

  root.querySelectorAll(".filter-sheet-option span:first-child, .plan-area-row > span, .detail-fact > span:last-child").forEach((el) => {
    const parts = el.textContent.split("·").map((part) => part.trim());
    let changed = false;
    const localized = parts.map((part) => {
      const next = HY_REGION[part];
      if (next) changed = true;
      return next || part;
    });
    if (changed) {
      const nextText = localized.join(" · ");
      if (el.textContent !== nextText) el.textContent = nextText;
    }
  });
}

function managerChannelGuess() {
  const source = `${state.user?.position || ""} ${state.user?.name || ""}`.toLowerCase();
  if (source.includes("davtashen") || source.includes("դավթաշեն")) return "SM Davtashen";
  if (source.includes("shirak") || source.includes("gyumri") || source.includes("շիրակ") || source.includes("գյումրի")) return "SM Shirak";
  if (source.includes("b2b")) return "SM B2B";
  if (source.includes("sm cas") || source.includes("sales manager cas")) return "SM CAS";
  if (source.includes("yvn") || source.includes("yerevan") || source.includes("երևան")) return "SM YVN";
  return "";
}

function enhanceNewCustomerForm(root = document) {
  const form = root.querySelector("#new-customer-form");
  if (!form || form.dataset.kadEnhanced === "true") return;
  form.dataset.kadEnhanced = "true";

  if (getLang() === "hy") {
    const nameInput = form.querySelector('input[name="name"]');
    const label = nameInput?.closest("label");
    if (label?.firstChild?.nodeType === Node.TEXT_NODE) label.firstChild.textContent = "Անվանում";
  }

  if (state.user?.role === "sales_manager") {
    const select = form.querySelector('select[name="sales_channel"]');
    const label = select?.closest("label");
    const guessed = managerChannelGuess();
    if (select && guessed) {
      let option = [...select.options].find((item) => item.value === guessed);
      if (!option) {
        option = new Option(guessed, guessed);
        select.add(option);
      }
      select.value = guessed;
    }
    // Sales managers never choose this manually. The server independently
    // resolves and overwrites the channel at create time as the authority.
    if (label) label.hidden = true;
  }

  localizeRegionControls(form);
}

function updateDisplayedVersion(root = document) {
  root.querySelectorAll(".settings-row-value").forEach((el) => {
    const current = el.textContent;
    if (!/\b1\.\d+\.\d+\b/.test(current)) return;
    const next = current.replace(/\b1\.\d+\.\d+\b/, APP_VERSION);
    if (next !== current) el.textContent = next;
  });
}

function enhanceAll(root = document) {
  enhanceNewCustomerForm(root);
  localizeRegionControls(root);
  updateDisplayedVersion(root);
}

function boot() {
  enhanceAll();
  // Batched into one rAF-deferred pass per frame instead of running
  // enhanceAll() synchronously, once per added element, inside the
  // mutation callback itself -- a big list re-render (hundreds of rows)
  // used to mean hundreds of synchronous enhanceAll() calls before the
  // browser could paint the frame that triggered them.
  let pendingNodes = [];
  let scheduled = false;
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) pendingNodes.push(node);
      });
    }
    if (!scheduled && pendingNodes.length) {
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const nodes = pendingNodes;
        pendingNodes = [];
        for (const node of nodes) {
          if (node.isConnected) enhanceAll(node);
        }
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
