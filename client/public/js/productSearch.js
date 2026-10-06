// Product search shared by the order screens. Every whitespace-separated word
// of the query must match (in any order) somewhere in the product's name,
// SKU, brand, family, size or HC code; matching ignores case, accents,
// dashes and spacing, so "edge 0w20 c5 4l" finds "Edge 0W-20 C5 4 L" and
// "5w30" finds "5W-30". The searchable text is built once per product.
const indexCache = new WeakMap();

function fold(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

const squash = (s) => s.replace(/[^\p{L}\p{N}]/gu, "");

function indexOf(product) {
  let idx = indexCache.get(product);
  if (!idx) {
    const text = fold([product.name, product.sku, product.brand, product.family, product.unit, product.hc_code].filter(Boolean).join(" "));
    idx = { text, squashed: squash(text) };
    indexCache.set(product, idx);
  }
  return idx;
}

export function searchProducts(products, query) {
  const tokens = fold(query).split(/\s+/).filter(Boolean);
  if (!tokens.length) return products;
  return products.filter((p) => {
    const { text, squashed } = indexOf(p);
    return tokens.every((tok) => {
      if (text.includes(tok)) return true;
      const sq = squash(tok);
      return sq ? squashed.includes(sq) : true;
    });
  });
}

// Wraps a handler so rapid keystrokes collapse into one call.
export function debounce(fn, ms = 150) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
