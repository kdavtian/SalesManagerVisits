// Centralized scale-2 half-unit arithmetic for the Bonuses module (see
// docs/bonuses-design.md section 10): every collectible quantity
// and point amount that can take a 0.5 step (carrots, activity points) is
// stored in the database as a plain INTEGER at 2x its real value --
// 0.5 carrot is stored as 1, 2.5 points is stored as 5 -- so ledger rows
// never accumulate the binary floating-point error a NUMERIC(x,1) column
// or raw JS float arithmetic would eventually introduce over thousands of
// rows. Every place that computes, stores, reads, or displays one of these
// quantities must go through these two functions, not reimplement the *2/
// /2 conversion inline -- that's the whole point of centralizing it.
//
// Whole-only collectibles (strawberry, apple, cherry, watermelon, and
// product-challenge piece counts) never need this -- store and use them as
// plain integers, scale factor 1.

const SCALE = 2;

// A real quantity (0, 0.5, 1, 2.5, 100, ...) -> the integer stored in the
// database. Throws on a value that isn't a multiple of 0.5 (the only step
// this module ever needs to represent) -- a silent round would hide a bug
// in whatever computed the input rather than surface it.
export function toScaled(amount) {
  const scaled = amount * SCALE;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-9) {
    throw new Error(`toScaled: ${amount} is not a multiple of 0.5`);
  }
  return rounded;
}

// The inverse -- a stored integer back to its real quantity, for API
// responses and display.
export function fromScaled(stored) {
  return stored / SCALE;
}

// Formats a scaled integer as a display string with no more decimal places
// than the value actually needs -- "1" for a whole carrot (stored 2), "0.5"
// for a half (stored 1), never "1.0" or "0.50".
export function formatScaled(stored) {
  const value = fromScaled(stored);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

// Sums an array of already-scaled integers -- exists mainly so call sites
// read as "sum of scaled quantities" rather than a bare `.reduce`, and so
// there's one place to add overflow/sanity bounds later if ever needed.
export function sumScaled(values) {
  return values.reduce((total, v) => total + v, 0);
}
