// Small JPEG copies of uploaded photos, so a grid of 30 photos is ~0.5 MB instead of ~9 MB (owner, 2026-10-26: "Photos load too slow").
// Made on first request, kept under uploads/thumbs, and rotated upright from the camera's EXIF flag. If the image library is missing or
// the file cannot be decoded, callers fall back to the original file: a photo must always show.
import fs from "node:fs";
import path from "node:path";

const THUMB_WIDTH = 360;
let sharpPromise = null;

function loadSharp() {
  if (!sharpPromise) sharpPromise = import("sharp").then((m) => m.default).catch(() => null);
  return sharpPromise;
}

const inFlight = new Map();

// A smaller JPEG copy of an uploaded photo under uploads/<sub>/<name>.jpg, made once (rotated upright); null when none can be made.
async function sizedCopy(uploadDir, storedName, { sub, width, quality }) {
  const rel = path.basename(storedName);
  const dir = path.join(uploadDir, sub);
  const target = path.join(dir, `${rel}.jpg`);
  if (fs.existsSync(target)) return target;
  if (inFlight.has(target)) return inFlight.get(target);
  const job = (async () => {
    const sharp = await loadSharp();
    if (!sharp) return null;
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      await sharp(path.join(uploadDir, rel), { failOn: "none" })
        .rotate()
        .resize({ width, height: width, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: false })
        .toFile(tmp);
      await fs.promises.rename(tmp, target);
      return target;
    } catch {
      return null;
    }
  })().finally(() => inFlight.delete(target));
  inFlight.set(target, job);
  return job;
}

// Resolves to the path of the thumbnail (grids), or null when none can be made.
export const thumbnailPathFor = (uploadDir, storedName) => sizedCopy(uploadDir, storedName, { sub: "thumbs", width: THUMB_WIDTH, quality: 70 });

// The copy the viewer shows first (owner, 2026-10-30: "photos open too slowly"): sharp on any phone or computer screen at a fraction of
// the original's size (a 2400 px photo of ~1 MB -> ~200 KB); the original is fetched only when the person zooms in.
const SCREEN_WIDTH = 1600;
export const screenPathFor = (uploadDir, storedName) => sizedCopy(uploadDir, storedName, { sub: "screens", width: SCREEN_WIDTH, quality: 80 });

// Delete a photo's thumbnail together with the photo itself.
export function removeThumbnail(uploadDir, storedName) {
  fs.unlink(path.join(uploadDir, "thumbs", `${path.basename(storedName)}.jpg`), () => {});
  fs.unlink(path.join(uploadDir, "screens", `${path.basename(storedName)}.jpg`), () => {});
}

// Right after an upload (owner, 2026-10-30: "photos and PDFs open too slowly"): a photo's screen copy and thumbnail, or a PDF's picture,
// are made in the background so the first open is instant instead of waiting for them. Never fails the upload.
export function warmUploadCopies(uploadDir, storedName, mime) {
  setImmediate(async () => {
    try {
      if (String(mime).startsWith("image/")) {
        await screenPathFor(uploadDir, storedName);
        await thumbnailPathFor(uploadDir, storedName);
      } else if (mime === "application/pdf") {
        const { warmPdfPreview } = await import("../shared/pdfPreview.js");
        warmPdfPreview(path.join(uploadDir, path.basename(storedName)));
      }
    } catch {
      // made on first request instead
    }
  });
}
