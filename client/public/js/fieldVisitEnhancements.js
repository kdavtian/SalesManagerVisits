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

function translatedRegion(value) {
  return getLang() === "hy" ? HY_REGION[String(value).trim()] || value : value;
}

function localizeRegionControls(root = document) {
  if (getLang() !== "hy") return;

  root.querySelectorAll("select option").forEach((option) => {
    const key = option.value || option.textContent.trim();
    if (HY_REGION[key]) option.textContent = HY_REGION[key];
  });

  root.querySelectorAll(".filter-sheet-option span:first-child, .plan-area-row > span, .detail-fact > span:last-child").forEach((el) => {
    const parts = el.textContent.split("·").map((part) => part.trim());
    let changed = false;
    const localized = parts.map((part) => {
      const next = HY_REGION[part];
      if (next) changed = true;
      return next || part;
    });
    if (changed) el.textContent = localized.join(" · ");
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

function enhancePhotoLightbox(root = document) {
  const overlay = root.querySelector(".photo-lightbox-overlay");
  if (!overlay || overlay.dataset.zoomEnhanced === "true") return;
  overlay.dataset.zoomEnhanced = "true";

  const img = overlay.querySelector(".photo-lightbox-img");
  if (!img) return;
  let scale = 1;
  let pinchStartDistance = 0;
  let pinchStartScale = 1;
  let lastTap = 0;

  const controls = document.createElement("div");
  controls.className = "photo-zoom-controls";
  controls.innerHTML = `
    <button type="button" data-photo-zoom="out" aria-label="Zoom out">−</button>
    <button type="button" data-photo-zoom="reset" aria-label="Reset zoom">1×</button>
    <button type="button" data-photo-zoom="in" aria-label="Zoom in">+</button>
  `;
  overlay.appendChild(controls);

  function applyScale(next) {
    scale = Math.min(5, Math.max(1, next));
    img.style.transform = `scale(${scale})`;
    img.classList.toggle("photo-lightbox-img-zoomed", scale > 1.01);
    controls.querySelector('[data-photo-zoom="reset"]').textContent = scale === 1 ? "1×" : `${scale.toFixed(1)}×`;
  }

  controls.addEventListener("click", (event) => {
    event.stopPropagation();
    const action = event.target.closest("button")?.dataset.photoZoom;
    if (action === "in") applyScale(scale + 0.5);
    else if (action === "out") applyScale(scale - 0.5);
    else if (action === "reset") applyScale(1);
  });

  img.addEventListener("dblclick", (event) => {
    event.preventDefault();
    event.stopPropagation();
    applyScale(scale > 1 ? 1 : 2);
  });

  overlay.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length === 2) {
        const [a, b] = event.touches;
        pinchStartDistance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        pinchStartScale = scale;
      } else if (event.touches.length === 1) {
        const now = Date.now();
        if (now - lastTap < 280) {
          event.preventDefault();
          applyScale(scale > 1 ? 1 : 2);
          lastTap = 0;
        } else {
          lastTap = now;
        }
      }
    },
    { capture: true, passive: false }
  );

  overlay.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length !== 2 || !pinchStartDistance) return;
      event.preventDefault();
      const [a, b] = event.touches;
      const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      applyScale(pinchStartScale * (distance / pinchStartDistance));
    },
    { capture: true, passive: false }
  );

  // When zoomed, a drag should not be interpreted by the existing gallery
  // handler as a next/previous-photo swipe.
  overlay.addEventListener(
    "touchend",
    (event) => {
      if (scale > 1.01) event.stopImmediatePropagation();
      if (event.touches.length < 2) pinchStartDistance = 0;
    },
    { capture: true }
  );

  overlay.addEventListener("wheel", (event) => {
    if (!event.ctrlKey && Math.abs(event.deltaY) < 1) return;
    event.preventDefault();
    applyScale(scale + (event.deltaY < 0 ? 0.25 : -0.25));
  }, { passive: false });

  const observer = new MutationObserver(() => applyScale(1));
  observer.observe(img, { attributes: true, attributeFilter: ["src"] });
  applyScale(1);
}

function updateDisplayedVersion(root = document) {
  root.querySelectorAll(".settings-row-value").forEach((el) => {
    if (/\b1\.\d+\.\d+\b/.test(el.textContent)) {
      el.textContent = el.textContent.replace(/\b1\.\d+\.\d+\b/, APP_VERSION);
    }
  });
}

function enhanceAll(root = document) {
  enhanceNewCustomerForm(root);
  enhancePhotoLightbox(root);
  localizeRegionControls(root);
  updateDisplayedVersion(root);
}

function boot() {
  enhanceAll();
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) enhanceAll(node);
      });
    }
    enhanceAll();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
