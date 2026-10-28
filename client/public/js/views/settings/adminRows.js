// Settings > Administration: what each admin row opens (moved out of settings.js with the refactor tool, docs/architecture-roadmap.md
// step 6). Takes the screen's state as `ctx` (the ctx object in renderSettings).
import { api } from "../../api.js";
import { t } from "../../i18n.js";
import { escapeHtml, formatAmd, openInfoPopup } from "../../util.js";
import { openAdminSection } from "./sheets.js";
import { renderNotificationDefaultsSection, renderReportsManagementSection } from "./notifications.js";
import { renderTeamSection } from "../admin/team.js";
import { renderClientErrorLogSection, renderDataQualitySection, renderNotificationDeliveryLogSection, renderPlacesSection, renderPointsCloseoutSection, renderQuickActionVisibilitySection, renderSalesChannelOwnersSection } from "../admin.js";
import { renderDocumentTextsSection, renderVisitFrequencyTypesSection } from "../settingsDocTexts.js";
import { renderSystemHealthSection } from "../systemHealth.js";

// --- Admin ---
export function wireAdminRows(ctx) {
  if (ctx.admin) {
    const radiusForm = ctx.root.querySelector("#radius-form");
    const radiusInput = radiusForm.querySelector('input[name="radius"]');
    const radiusSuccess = ctx.root.querySelector("#radius-success");
    const frequencyForm = ctx.root.querySelector("#visit-frequency-form");
    const frequencyInput = frequencyForm.querySelector('input[name="days"]');
    const frequencySuccess = ctx.root.querySelector("#visit-frequency-success");
    const askKadToggle = ctx.root.querySelector("#toggle-ask-kad");
    const askKadCapForm = ctx.root.querySelector("#ask-kad-cap-form");
    const askKadCapInput = askKadCapForm.querySelector('input[name="usd"]');
    const askKadCapSuccess = ctx.root.querySelector("#ask-kad-cap-success");
    const aiCheckToggle = ctx.root.querySelector("#toggle-ai-check");
    const aiCheckCapForm = ctx.root.querySelector("#ai-check-cap-form");
    const aiCheckCapInput = aiCheckCapForm.querySelector('input[name="usd"]');
    const aiCheckCapSuccess = ctx.root.querySelector("#ai-check-cap-success");
    const landingToggle = ctx.root.querySelector("#toggle-landing-calc");
    const landingRateForm = ctx.root.querySelector("#landing-rate-form");
    const landingRateInput = landingRateForm.querySelector('input[name="rate"]');
    const landingRateSuccess = ctx.root.querySelector("#landing-rate-success");
    const landingRatesForm = ctx.root.querySelector("#landing-rates-form");
    const landingRatesSuccess = ctx.root.querySelector("#landing-rates-success");
    let landingRateDefaults = {};
    // A field shows its value only when it differs from the built-in one; an empty field shows the built-in value as its placeholder.
    const paintLandingRates = (rates, defaults) => {
      landingRateDefaults = defaults || {};
      for (const input of landingRatesForm.querySelectorAll("input[name]")) {
        const key = input.name;
        input.placeholder = landingRateDefaults[key] ?? "";
        input.value = rates?.[key] !== undefined && rates[key] !== landingRateDefaults[key] ? rates[key] : "";
      }
    };
    const retailToggle = ctx.root.querySelector("#toggle-retail-excel");
    const planSkipForm = ctx.root.querySelector("#plan-skip-form");
    const planSkipInput = planSkipForm.querySelector('input[name="days"]');
    const planSkipSuccess = ctx.root.querySelector("#plan-skip-success");
    const incentiveForm = ctx.root.querySelector("#incentive-message-form");
    const incentiveInput = incentiveForm.querySelector('input[name="message"]');
    const incentiveSuccess = ctx.root.querySelector("#incentive-message-success");
    const pinForm = ctx.root.querySelector("#calculator-pin-form");
    const pinInput = pinForm.querySelector('input[name="pin"]');
    const pinSuccess = ctx.root.querySelector("#calculator-pin-success");
    const pinStatus = ctx.root.querySelector("#calculator-pin-status");
    const calcModeToggle = ctx.root.querySelector("#toggle-calculator-mode");
    const calcModeToggleValue = calcModeToggle.closest(".settings-toggle-row").querySelector(".settings-row-value");
    const calcModeHelp = ctx.root.querySelector("#calculator-mode-help");
    const bonusesToggle = ctx.root.querySelector("#toggle-bonuses-enabled");
    const bonusesToggleValue = bonusesToggle?.closest(".settings-toggle-row").querySelector(".settings-row-value");
    const disconnectBtn = ctx.root.querySelector("#emergency-disconnect-btn");

    const allowanceToggle = ctx.root.querySelector("#toggle-checkin-allowance");
    function paintAllowanceToggle(enabled) {
      allowanceToggle.setAttribute("aria-checked", String(enabled));
      radiusForm.classList.toggle("is-off", !enabled);
    }

    function paintCalcModeToggle(enabled) {
      calcModeToggle.setAttribute("aria-checked", String(enabled));
      calcModeToggleValue.textContent = enabled ? t("toggle_on") : t("toggle_off");
      calcModeHelp.textContent = enabled ? t("calculator_mode_help_on") : t("calculator_mode_help_off");
    }

    api.getSettings().then((s) => {
      radiusInput.value = s.checkin_radius_meters;
      paintAllowanceToggle(s.checkin_allowance_enabled !== false);
      frequencyInput.value = s.default_visit_frequency_days;
      planSkipInput.value = s.plan_skip_recent_visit_days ?? 4;
      incentiveInput.value = s.incentive_message || "";
      askKadToggle.setAttribute("aria-checked", String(s.ask_kad_enabled !== false));
      landingToggle.setAttribute("aria-checked", String(s.landing_calc_enabled !== false));
      landingRateInput.value = s.landing_usd_rate ?? 366;
      paintLandingRates(s.landing_rates, s.landing_rate_defaults);
      retailToggle.setAttribute("aria-checked", String(s.retail_from_excel === true));
      askKadCapInput.value = s.ask_kad_monthly_cap_usd ?? 20;
      aiCheckToggle.setAttribute("aria-checked", String(Boolean(s.ai_blank_check_enabled)));
      aiCheckCapInput.value = s.ai_blank_check_monthly_cap_usd ?? 10;
      ctx.root.querySelector("#ai-check-no-key").hidden = s.ai_blank_check_configured !== false;
      // Write-only field (see routes/settings.js) -- never pre-filled with
      // the actual code, just a status line saying whether one is set.
      pinStatus.textContent = s.calculator_pin_is_custom ? t("calculator_pin_help_custom") : t("calculator_pin_help");
      paintCalcModeToggle(s.calculator_mode_enabled);
      if (bonusesToggle) paintBonusesToggle(s.bonuses_enabled);
    });

    // Instant save, no confirm(): switching it back is one tap.
    allowanceToggle.addEventListener("click", async () => {
      const turningOn = allowanceToggle.getAttribute("aria-checked") !== "true";
      allowanceToggle.disabled = true;
      try {
        const result = await api.updateSettings({ checkin_allowance_enabled: turningOn });
        paintAllowanceToggle(result.checkin_allowance_enabled);
      } catch (err) {
        alert(err.message);
      } finally {
        allowanceToggle.disabled = false;
      }
    });

    calcModeToggle.addEventListener("click", async () => {
      const turningOn = calcModeToggle.getAttribute("aria-checked") !== "true";
      if (!confirm(turningOn ? t("calculator_mode_confirm_on") : t("calculator_mode_confirm_off"))) return;
      calcModeToggle.disabled = true;
      try {
        const result = await api.updateSettings({ calculator_mode_enabled: turningOn });
        paintCalcModeToggle(result.calculator_mode_enabled);
      } catch (err) {
        alert(err.message);
      } finally {
        calcModeToggle.disabled = false;
      }
    });

    function paintBonusesToggle(enabled) {
      bonusesToggle.setAttribute("aria-checked", String(enabled));
      bonusesToggleValue.textContent = enabled ? t("toggle_on") : t("toggle_off");
    }

    if (bonusesToggle) {
      bonusesToggle.addEventListener("click", async () => {
        const turningOn = bonusesToggle.getAttribute("aria-checked") !== "true";
        bonusesToggle.disabled = true;
        try {
          const result = await api.updateSettings({ bonuses_enabled: turningOn });
          paintBonusesToggle(result.bonuses_enabled);
        } catch (err) {
          alert(err.message);
        } finally {
          bonusesToggle.disabled = false;
        }
      });
    }

    disconnectBtn.addEventListener("click", async () => {
      if (!confirm(t("emergency_disconnect_confirm"))) return;
      disconnectBtn.disabled = true;
      try {
        await api.engageLockdown();
        // Our own session just got invalidated along with everyone
        // else's -- reload so bootGate/app.js's lockdown check takes over
        // and shows the lockdown screen instead of a broken half-logged-in
        // state.
        location.reload();
      } catch (err) {
        alert(err.message);
        disconnectBtn.disabled = false;
      }
    });

    radiusForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      radiusSuccess.hidden = true;
      const submitBtn = radiusForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.updateSettings({ checkin_radius_meters: Number(radiusInput.value) });
        radiusSuccess.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });

    frequencyForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      frequencySuccess.hidden = true;
      const submitBtn = frequencyForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.updateSettings({ default_visit_frequency_days: Number(frequencyInput.value) });
        frequencySuccess.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });

    // Instant save, like the check-in allowance switch: switching it back is one tap.
    askKadToggle.addEventListener("click", async () => {
      const turningOn = askKadToggle.getAttribute("aria-checked") !== "true";
      askKadToggle.disabled = true;
      try {
        const result = await api.updateSettings({ ask_kad_enabled: turningOn });
        askKadToggle.setAttribute("aria-checked", String(result.ask_kad_enabled));
      } catch (err) {
        alert(err.message);
      } finally {
        askKadToggle.disabled = false;
      }
    });
    // The AI check of photographed order blanks: OFF by default, one tap each way.
    aiCheckToggle.addEventListener("click", async () => {
      const turningOn = aiCheckToggle.getAttribute("aria-checked") !== "true";
      aiCheckToggle.disabled = true;
      try {
        const result = await api.updateSettings({ ai_blank_check_enabled: turningOn });
        aiCheckToggle.setAttribute("aria-checked", String(result.ai_blank_check_enabled));
      } catch (err) {
        alert(err.message);
      } finally {
        aiCheckToggle.disabled = false;
      }
    });
    aiCheckCapForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      aiCheckCapSuccess.hidden = true;
      const submitBtn = aiCheckCapForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.updateSettings({ ai_blank_check_monthly_cap_usd: Number(aiCheckCapInput.value) });
        aiCheckCapSuccess.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });
    // Landing cost from the pack price: the switch and the USD rate recalculate every product on the server at once.
    landingToggle.addEventListener("click", async () => {
      const turningOn = landingToggle.getAttribute("aria-checked") !== "true";
      landingToggle.disabled = true;
      try {
        const result = await api.updateSettings({ landing_calc_enabled: turningOn });
        landingToggle.setAttribute("aria-checked", String(result.landing_calc_enabled));
      } catch (err) {
        alert(err.message);
      } finally {
        landingToggle.disabled = false;
      }
    });
    landingRateForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      landingRateSuccess.hidden = true;
      const submitBtn = landingRateForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.updateSettings({ landing_usd_rate: Number(landingRateInput.value) });
        landingRateSuccess.hidden = false;
      } catch (err) {
        alert(err.message);
      } finally {
        submitBtn.disabled = false;
      }
    });
    landingRatesForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      landingRatesSuccess.hidden = true;
      const submitBtn = landingRatesForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const body = {};
        for (const input of landingRatesForm.querySelectorAll("input[name]")) body[input.name] = input.value.trim() === "" ? null : Number(input.value.replace(",", "."));
        const result = await api.updateSettings({ landing_rates: body });
        paintLandingRates(result.landing_rates, result.landing_rate_defaults);
        landingRatesSuccess.hidden = false;
      } catch (err) {
        alert(err.message);
      } finally {
        submitBtn.disabled = false;
      }
    });
    ctx.root.querySelector("#landing-rates-reset").addEventListener("click", () => {
      for (const input of landingRatesForm.querySelectorAll("input[name]")) input.value = "";
      landingRatesForm.requestSubmit();
    });
    // Retail price from Excel: the switch applies Excel's prices right away; the button lists what would change first.
    retailToggle.addEventListener("click", async () => {
      const turningOn = retailToggle.getAttribute("aria-checked") !== "true";
      retailToggle.disabled = true;
      try {
        const result = await api.updateSettings({ retail_from_excel: turningOn });
        retailToggle.setAttribute("aria-checked", String(result.retail_from_excel));
      } catch (err) {
        alert(err.message);
      } finally {
        retailToggle.disabled = false;
      }
    });
    ctx.root.querySelector("#retail-diff-btn").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const { products } = await api.retailDifferences();
        const rows = products
          .map((p) => `<li><span>${escapeHtml([p.brand, p.name, p.unit].filter(Boolean).join(" "))}</span><b>${formatAmd(p.app_retail)} → ${formatAmd(p.excel_retail)}</b></li>`)
          .join("");
        openInfoPopup(`<h3>${t("retail_diff_title")}</h3>${rows ? `<ul class="retail-diff">${rows}</ul>` : `<p>${t("retail_diff_none")}</p>`}`);
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
      }
    });
    askKadCapForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      askKadCapSuccess.hidden = true;
      const submitBtn = askKadCapForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.updateSettings({ ask_kad_monthly_cap_usd: Number(askKadCapInput.value) });
        askKadCapSuccess.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });

    planSkipForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      planSkipSuccess.hidden = true;
      const submitBtn = planSkipForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.updateSettings({ plan_skip_recent_visit_days: Number(planSkipInput.value) });
        planSkipSuccess.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });

    incentiveForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      incentiveSuccess.hidden = true;
      const submitBtn = incentiveForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        await api.updateSettings({ incentive_message: incentiveInput.value });
        incentiveSuccess.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });

    pinForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      pinSuccess.hidden = true;
      const value = pinInput.value.trim();
      if (value && !/^\d{4,8}$/.test(value)) {
        pinStatus.textContent = t("calculator_pin_error");
        return;
      }
      const submitBtn = pinForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      try {
        const result = await api.updateSettings({ calculator_pin: value });
        pinInput.value = "";
        pinStatus.textContent = result.calculator_pin_is_custom ? t("calculator_pin_help_custom") : t("calculator_pin_help");
        pinSuccess.hidden = false;
      } finally {
        submitBtn.disabled = false;
      }
    });

    ctx.root.querySelector("#row-team-management").addEventListener("click", (e) => {
      openAdminSection(ctx.root, e.currentTarget, t("team_management"), renderTeamSection);
    });
    ctx.root.querySelector("#row-notification-defaults").addEventListener("click", (e) => {
      openAdminSection(ctx.root, e.currentTarget, t("notification_defaults_title"), renderNotificationDefaultsSection);
    });
    ctx.root.querySelector("#row-points-closeout").addEventListener("click", (e) => {
      openAdminSection(ctx.root, e.currentTarget, t("points_closeout_title"), renderPointsCloseoutSection);
    });
    ctx.root.querySelector("#row-admin-sessions").addEventListener("click", async () => {
      if (!confirm(t("confirm_log_out_other_sessions"))) return;
      await api.logoutOtherSessions();
      alert(t("other_sessions_logged_out"));
    });
    ctx.root.querySelector("#row-reports-management").addEventListener("click", (e) => {
      openAdminSection(ctx.root, e.currentTarget, t("reports_management"), renderReportsManagementSection);
    });
    ctx.root.querySelector("#row-quick-actions").addEventListener("click", (e) => {
      openAdminSection(ctx.root, e.currentTarget, t("quick_action_visibility_title"), renderQuickActionVisibilitySection);
    });
    ctx.root.querySelector("#row-visit-types").addEventListener("click", (e) => {
      openAdminSection(ctx.root, e.currentTarget, t("visit_types_title"), renderVisitFrequencyTypesSection);
    });
    ctx.root.querySelector("#row-doc-texts").addEventListener("click", (e) => {
      openAdminSection(ctx.root, e.currentTarget, t("doc_texts_title"), renderDocumentTextsSection);
    });
    ctx.root.querySelector("#row-sales-channel-owners").addEventListener("click", (e) => {
      openAdminSection(ctx.root, e.currentTarget, t("sales_channel_owners_title"), renderSalesChannelOwnersSection);
    });
    ctx.root.querySelector("#row-data-quality").addEventListener("click", (e) => {
      openAdminSection(ctx.root, e.currentTarget, t("data_quality_title"), renderDataQualitySection);
    });
    ctx.root.querySelector("#row-places").addEventListener("click", (e) => {
      openAdminSection(ctx.root, e.currentTarget, t("places_title"), renderPlacesSection);
    });
    ctx.root.querySelector("#row-system-health").addEventListener("click", (e) => {
      openAdminSection(ctx.root, e.currentTarget, t("system_health_title"), renderSystemHealthSection);
    });
    ctx.root.querySelector("#row-notification-delivery-log").addEventListener("click", (e) => {
      openAdminSection(ctx.root, e.currentTarget, t("notification_delivery_log_title"), renderNotificationDeliveryLogSection);
    });
    ctx.root.querySelector("#row-client-error-log").addEventListener("click", (e) => {
      openAdminSection(ctx.root, e.currentTarget, t("client_error_log_title"), renderClientErrorLogSection);
    });
  }
}
