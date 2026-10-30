// Neutral, made-up street-map tiles (the sandbox cannot reach OpenStreetMap). Seamless: everything is drawn in world pixels.
const h = (a, b, c = 0) => { let x = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647); x = Math.imul(x ^ (x >>> 13), 1274126177); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; };
const LEVELS = [ // spacing at z16 px, width px, colour, casing, min zoom spacing
  { s: 110, w: 1.6, c: "#ffffff", k: null, amp: 0.18 },
  { s: 440, w: 3.2, c: "#ffffff", k: "#e3ddd2", amp: 0.22 },
  { s: 1760, w: 5.5, c: "#fdf3d4", k: "#e8d9ae", amp: 0.12 },
];
export function tileSvg(z, x, y) {
  const sc = 2 ** (z - 16), T = 256, x0 = x * T, y0 = y * T;
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="#f3f0ea"/>`;
  // parks
  const ps = 900 * sc;
  if (ps > 6) for (let i = Math.floor((x0 - ps) / ps); i <= Math.floor((x0 + T + ps) / ps); i++) for (let j = Math.floor((y0 - ps) / ps); j <= Math.floor((y0 + T + ps) / ps); j++) {
    if (h(i, j, 7) > 0.33) continue;
    const cx = (i + 0.2 + 0.6 * h(i, j, 8)) * ps - x0, cy = (j + 0.2 + 0.6 * h(i, j, 9)) * ps - y0;
    out += `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${(ps * (0.12 + 0.12 * h(i, j, 10))).toFixed(1)}" ry="${(ps * (0.09 + 0.1 * h(i, j, 11))).toFixed(1)}" fill="#d8ebcf"/>`;
  }
  // river (world line, gentle curve)
  const riverPts = [];
  for (let t = -40; t <= T + 40; t += 8) riverPts.push([t, y0 + t]);
  const rw = Math.max(3, 60 * sc);
  const riverPath = riverPts.map(([t, wy], k) => { const wz = wy / sc; const wx = (0.42 * wz + 1400 * Math.sin(wz / 2600) + 7792000) * sc; return `${k ? "L" : "M"}${(wx - x0).toFixed(1)},${t.toFixed(1)}`; }).join("");
  out += `<path d="${riverPath}" stroke="#bcd7ea" stroke-width="${rw.toFixed(1)}" fill="none" stroke-linecap="round"/>`;
  for (const [li, L] of LEVELS.entries()) {
    const s = L.s * sc; if (s < 20) continue;
    const w = Math.max(1, L.w * Math.min(1.6, Math.max(0.55, sc * 2 ** (li === 0 ? 0 : 1)))) ;
    const lines = [];
    for (let i = Math.floor((x0 - s) / s); i <= Math.floor((x0 + T + s) / s); i++) { // vertical-ish
      const ph = h(i, li, 1) * 6.28, a = L.amp * s; let d = "";
      for (let t = -10, k = 0; t <= T + 10; t += 6, k++) { const wy = y0 + t; const wx = i * s + a * Math.sin(wy / (2.3 * s) + ph); d += `${k ? "L" : "M"}${(wx - x0).toFixed(1)},${t}`; }
      lines.push(d);
    }
    for (let j = Math.floor((y0 - s) / s); j <= Math.floor((y0 + T + s) / s); j++) { // horizontal-ish, slight tilt
      const ph = h(j, li, 2) * 6.28, a = L.amp * s; let d = "";
      for (let t = -10, k = 0; t <= T + 10; t += 6, k++) { const wx = x0 + t; const wy = j * s + a * Math.sin(wx / (2.7 * s) + ph); d += `${k ? "L" : "M"}${t},${(wy - y0).toFixed(1)}`; }
      lines.push(d);
    }
    if (L.k) out += `<path d="${lines.join("")}" stroke="${L.k}" stroke-width="${(w + 2).toFixed(1)}" fill="none"/>`;
    out += `<path d="${lines.join("")}" stroke="${L.c}" stroke-width="${w.toFixed(1)}" fill="none"/>`;
  }
  return out + "</svg>";
}
