// A PDF as ONE light JPEG (owner, 2026-10-27: documents opened slowly, needed extra steps and sometimes did not open at all on a phone).
// The viewer shows this picture at once instead of handing the PDF to the phone's own reader, and "Save" stores it in the phone's photos.
// Rendered with poppler's pdftoppm (installed in the Docker image), pages stacked top to bottom, kept next to the file so it is made once.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// Long side of each page in px (an A4 page -> about 1000 x 1400, ~150 KB: sharp on a phone, readable when zoomed, quick on a slow network).
// A fixed size, not a DPI, so a PDF with a giant page size cannot make a giant picture.
const PAGE_PX = 1400;
const MAX_PAGES = 10;
const QUALITY = 80;
let available = null; // false once pdftoppm turned out to be missing
const running = new Map();

function run(cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 30000 }, (err) => (err ? reject(err) : resolve())));
}

async function render(pdfPath, outPath) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pdfprev-"));
  try {
    await run("pdftoppm", ["-jpeg", "-jpegopt", `quality=${QUALITY}`, "-scale-to", String(PAGE_PX), "-l", String(MAX_PAGES), pdfPath, path.join(dir, "p")]);
    const pages = (await fs.promises.readdir(dir)).filter((f) => f.endsWith(".jpg")).sort((a, b) => Number(a.match(/(\d+)\.jpg$/)[1]) - Number(b.match(/(\d+)\.jpg$/)[1]));
    if (!pages.length) throw new Error("No page rendered");
    const tmpOut = `${outPath}.${crypto.randomUUID()}.tmp`;
    if (pages.length === 1) await fs.promises.copyFile(path.join(dir, pages[0]), tmpOut);
    else {
      // Several pages: one tall picture, a thin grey gap between the pages.
      const sharp = (await import("sharp")).default;
      const metas = await Promise.all(pages.map((p) => sharp(path.join(dir, p)).metadata()));
      const gap = 12;
      const width = Math.max(...metas.map((m) => m.width));
      const height = metas.reduce((s, m) => s + m.height, 0) + gap * (pages.length - 1);
      let top = 0;
      const layers = pages.map((p, i) => {
        const layer = { input: path.join(dir, p), top, left: Math.round((width - metas[i].width) / 2) };
        top += metas[i].height + gap;
        return layer;
      });
      await sharp({ create: { width, height, channels: 3, background: "#d9d9d9" } }).composite(layers).jpeg({ quality: QUALITY, mozjpeg: true }).toFile(tmpOut);
    }
    await fs.promises.rename(tmpOut, outPath);
    return outPath;
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** The JPEG of a PDF on disk (made once, then reused). null when the PDF cannot be rendered on this server. */
export async function pdfPreviewPath(pdfPath) {
  if (available === false) return null;
  const outPath = `${pdfPath}.preview.jpg`;
  try {
    const [pdf, jpg] = await Promise.all([fs.promises.stat(pdfPath), fs.promises.stat(outPath).catch(() => null)]);
    if (jpg && jpg.mtimeMs >= pdf.mtimeMs) return outPath;
  } catch {
    return null; // the PDF itself is missing
  }
  if (!running.has(outPath)) {
    running.set(
      outPath,
      render(pdfPath, outPath)
        .catch((err) => {
          if (err.code === "ENOENT" && String(err.syscall || "").startsWith("spawn")) available = false; // pdftoppm itself is missing
          else console.error("PDF preview failed:", err.message);
          return null;
        })
        .finally(() => running.delete(outPath))
    );
  }
  return running.get(outPath);
}

/** The JPEG of a PDF held in memory (a PDF stored in the database, or one the app just built): rendered in a temp folder, returned as a Buffer. */
export async function pdfBufferPreview(buffer, cachePath = null) {
  if (cachePath) {
    const hit = await fs.promises.readFile(cachePath).catch(() => null);
    if (hit) return hit;
  }
  if (available === false) return null;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pdfbuf-"));
  try {
    const pdfPath = path.join(dir, "in.pdf");
    await fs.promises.writeFile(pdfPath, buffer);
    const out = await pdfPreviewPath(pdfPath);
    if (!out) return null;
    const jpg = await fs.promises.readFile(out);
    if (cachePath) fs.promises.writeFile(cachePath, jpg).catch(() => {});
    return jpg;
  } finally {
    fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Starts making the preview now (a new signed act / payment slip), so the first look at it is instant. Never throws. */
export function warmPdfPreview(pdfPath) {
  pdfPreviewPath(pdfPath).catch(() => {});
}
