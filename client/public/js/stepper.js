// Quantity steppers (+ / -): a tap changes the quantity by 1, a long press by one PACK. Pack sizes follow how the
// goods are really handled: 0.5 L and 1 L bottles by the case of 12, 4 L and 5 L jugs by 4, 7 L by 3, 60 L and 208 L
// drums one at a time; everything else by 1. A long press snaps to the pack grid: 3 -> 12 -> 24 going up,
// 28 -> 24 -> 12 -> 0 going down, and anything below one pack goes straight to 0 (the line is removed).
export function packQty(unit) {
  const m = /^([\d.,]+)\s*L$/i.exec(String(unit || "").trim());
  const liters = m ? parseFloat(m[1].replace(",", ".")) : null;
  if (liters === 0.5 || liters === 1) return 12;
  if (liters === 4 || liters === 5) return 4;
  if (liters === 7) return 3;
  return 1;
}

export function packStepUp(qty, pack) {
  return (Math.floor(qty / pack) + 1) * pack;
}
export function packStepDown(qty, pack) {
  return Math.max(0, Math.floor((qty - 1) / pack) * pack);
}

const HOLD_MS = 450;

// Wires one stepper button. onTap runs for a normal press, onHold for a long press (and the click that follows a
// long press is swallowed). Works with touch, mouse and pen; the browser's own long-press menu is suppressed.
export function bindStepperButton(btn, { onTap, onHold }) {
  let timer = null;
  let held = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  btn.addEventListener("pointerdown", () => {
    held = false;
    cancel();
    timer = setTimeout(() => {
      held = true;
      navigator.vibrate?.(12);
      onHold();
    }, HOLD_MS);
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) btn.addEventListener(type, cancel);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    if (held) {
      held = false;
      e.preventDefault();
      return;
    }
    onTap();
  });
}
