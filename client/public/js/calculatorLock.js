// The disguise's front door: a plain, fully-working calculator. Deliberately
// has no imports from the rest of the app (no api.js, no i18n.js, no shared
// CSS) -- until the correct code is entered, nothing about the real app
// should be reachable from this screen, not even indirectly through a
// shared module that happens to reference it.
//
// Unlock mechanism: type the code as plain digits (nothing else -- no
// operator, no decimal point, no +/-, no %) and press "=". Pressing any
// operator at all before "=" takes the calculator down the normal
// arithmetic path instead and permanently rules out an unlock attempt
// until the next AC, so a real calculation (e.g. "1000+997=") can never
// accidentally match the code merely because its digits happen to add up
// right -- only a clean, uninterrupted digit entry can.
const VERIFY_ENDPOINT = "/api/calculator-lock/verify";

const BUTTONS = [
  [
    { label: "AC", kind: "clear" },
    { label: "+/-", kind: "sign" },
    { label: "%", kind: "percent" },
    { label: "÷", kind: "operator", value: "÷" },
  ],
  [
    { label: "7", kind: "digit" },
    { label: "8", kind: "digit" },
    { label: "9", kind: "digit" },
    { label: "×", kind: "operator", value: "×" },
  ],
  [
    { label: "4", kind: "digit" },
    { label: "5", kind: "digit" },
    { label: "6", kind: "digit" },
    { label: "-", kind: "operator", value: "-" },
  ],
  [
    { label: "1", kind: "digit" },
    { label: "2", kind: "digit" },
    { label: "3", kind: "digit" },
    { label: "+", kind: "operator", value: "+" },
  ],
  [
    { label: "0", kind: "digit", wide: true },
    { label: ".", kind: "decimal" },
    { label: "=", kind: "equals" },
  ],
];

function compute(a, operator, b) {
  switch (operator) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "×":
      return a * b;
    case "÷":
      return b === 0 ? NaN : a / b;
    default:
      return b;
  }
}

// Basic calculators trim float noise (0.1 + 0.2) by rounding to a fixed
// number of significant digits rather than showing it raw.
function formatNumber(n) {
  if (!Number.isFinite(n)) return "Error";
  const rounded = Number(n.toPrecision(12));
  return String(rounded);
}

export function renderCalculatorLock(container, onUnlock) {
  const style = document.createElement("style");
  style.textContent = `
    /* iOS/Android draw the home-indicator safe-area strip (and any
       elastic overscroll) as the document's own background, which
       .calc-lock's "position: fixed; inset: 0" doesn't reach -- without
       this, that strip shows the real app's light page background right
       through the bottom of an otherwise all-dark calculator screen. This
       rule lives in the same <style> tag calc-lock removes on unlock, so
       it never lingers into the real app's own (correctly light) look. */
    html, body { background: #1c1c1e; }
    .calc-lock { position: fixed; inset: 0; background: #1c1c1e; display: flex; flex-direction: column; justify-content: flex-end; z-index: 9999; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding-bottom: env(safe-area-inset-bottom); box-sizing: border-box; }
    .calc-lock-display { color: #fff; text-align: right; padding: 0 24px 16px; font-size: 4rem; font-weight: 300; line-height: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; }
    .calc-lock-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; padding: 0 12px 24px; }
    .calc-lock-btn { border: none; border-radius: 999px; aspect-ratio: 1 / 1; font-size: 1.7rem; font-weight: 500; color: #fff; background: #333335; cursor: pointer; -webkit-tap-highlight-color: transparent; }
    .calc-lock-btn:active { filter: brightness(1.3); }
    .calc-lock-btn.wide { grid-column: span 2; aspect-ratio: auto; text-align: left; padding-left: 28px; }
    .calc-lock-btn.op { background: #ff9f0a; }
    .calc-lock-btn.fn { background: #a5a5a5; color: #000; }
  `;

  let display = "0";
  let firstOperand = null;
  let pendingOperator = null;
  let waitingForSecondOperand = false;
  let digitLog = "";
  let pureDigitEntry = true;

  const root = document.createElement("div");
  root.className = "calc-lock";
  const displayEl = document.createElement("div");
  displayEl.className = "calc-lock-display";
  const grid = document.createElement("div");
  grid.className = "calc-lock-grid";

  function paint() {
    displayEl.textContent = display;
  }

  function clearAll() {
    display = "0";
    firstOperand = null;
    pendingOperator = null;
    waitingForSecondOperand = false;
    digitLog = "";
    pureDigitEntry = true;
  }

  function pressDigit(d) {
    if (pureDigitEntry) digitLog += d;
    if (waitingForSecondOperand) {
      display = d;
      waitingForSecondOperand = false;
    } else {
      display = display === "0" ? d : display + d;
    }
  }

  function pressDecimal() {
    pureDigitEntry = false;
    if (waitingForSecondOperand) {
      display = "0.";
      waitingForSecondOperand = false;
      return;
    }
    if (!display.includes(".")) display += ".";
  }

  function pressOperator(op) {
    pureDigitEntry = false;
    const value = Number(display);
    if (pendingOperator && !waitingForSecondOperand) {
      firstOperand = compute(firstOperand, pendingOperator, value);
      display = formatNumber(firstOperand);
    } else {
      firstOperand = value;
    }
    pendingOperator = op;
    waitingForSecondOperand = true;
  }

  function pressSign() {
    pureDigitEntry = false;
    if (display !== "0") display = display.startsWith("-") ? display.slice(1) : `-${display}`;
  }

  function pressPercent() {
    pureDigitEntry = false;
    display = formatNumber(Number(display) / 100);
  }

  async function pressEquals() {
    if (pendingOperator === null && pureDigitEntry && digitLog.length > 0) {
      const code = digitLog;
      // A wrong code should look exactly like a no-op "=" on a lone number
      // (which is what a real calculator does) -- no error state, no
      // visible difference, nothing to give the disguise away.
      try {
        const res = await fetch(VERIFY_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        if (res.ok) {
          const body = await res.json();
          if (body?.unlocked) {
            root.remove();
            style.remove();
            onUnlock();
            return;
          }
        }
      } catch {
        // Offline/unreachable: fall through and behave like a plain
        // calculator, same as a wrong code.
      }
      return;
    }
    if (pendingOperator !== null) {
      const value = Number(display);
      firstOperand = compute(firstOperand, pendingOperator, value);
      display = formatNumber(firstOperand);
      pendingOperator = null;
      waitingForSecondOperand = true;
    }
  }

  BUTTONS.forEach((row) => {
    row.forEach((btn) => {
      const el = document.createElement("button");
      el.type = "button";
      el.textContent = btn.label;
      el.className = "calc-lock-btn";
      if (btn.wide) el.classList.add("wide");
      if (btn.kind === "operator" || btn.kind === "equals") el.classList.add("op");
      if (btn.kind === "clear" || btn.kind === "sign" || btn.kind === "percent") el.classList.add("fn");

      el.addEventListener("click", () => {
        switch (btn.kind) {
          case "clear":
            clearAll();
            break;
          case "sign":
            pressSign();
            break;
          case "percent":
            pressPercent();
            break;
          case "digit":
            pressDigit(btn.label);
            break;
          case "decimal":
            pressDecimal();
            break;
          case "operator":
            pressOperator(btn.value);
            break;
          case "equals":
            pressEquals();
            break;
        }
        paint();
      });

      grid.appendChild(el);
    });
  });

  root.appendChild(displayEl);
  root.appendChild(grid);
  document.head.appendChild(style);
  container.replaceChildren(root);
  paint();
}
