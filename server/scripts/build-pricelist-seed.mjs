// Rebuilds server/seed/pricelist/ from the company's pricelist workbook:
//   node scripts/build-pricelist-seed.mjs path/to/KF_Pricelist_*.xlsx
// groups.json lists every model (sheet, brand, name, sizes, parsed technical
// text, image file) and the images are stored once per distinct picture.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parsePricelistWorkbook, parseTechText } from "../src/pricelistImport.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/build-pricelist-seed.mjs <pricelist.xlsx>");
  process.exit(1);
}
const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "seed", "pricelist");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "images"), { recursive: true });

const groups = await parsePricelistWorkbook(fs.readFileSync(file));
const out = groups.map((g) => {
  let image = null;
  if (g.image) {
    const ext = /^(jpe?g|png)$/i.test(g.image.ext) ? g.image.ext.toLowerCase().replace("jpeg", "jpg") : "png";
    image = `${crypto.createHash("sha1").update(g.image.buffer).digest("hex").slice(0, 16)}.${ext}`;
    fs.writeFileSync(path.join(outDir, "images", image), g.image.buffer);
  }
  return { sheet: g.sheet, brand: g.brand, name: g.name, sizes: g.sizes, commercial: g.commercial, tech: g.commercial ? parseTechText(g.tech) : null, image };
});
fs.writeFileSync(path.join(outDir, "groups.json"), JSON.stringify(out, null, 1));
console.log(`${out.length} models, ${new Set(out.map((g) => g.image).filter(Boolean)).size} distinct images -> ${outDir}`);
