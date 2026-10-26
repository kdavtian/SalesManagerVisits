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

// Resolves to the path of the thumbnail, or null when none can be made.
export async function thumbnailPathFor(uploadDir, storedName) {
  const rel = path.basename(storedName);
  const thumbDir = path.join(uploadDir, "thumbs");
  const target = path.join(thumbDir, `${rel}.jpg`);
  if (fs.existsSync(target)) return target;
  if (inFlight.has(target)) return inFlight.get(target);
  const job = (async () => {
    const sharp = await loadSharp();
    if (!sharp) return null;
    try {
      await fs.promises.mkdir(thumbDir, { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      await sharp(path.join(uploadDir, rel), { failOn: "none" })
        .rotate()
        .resize({ width: THUMB_WIDTH, height: THUMB_WIDTH, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 70, mozjpeg: false })
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

// Delete a photo's thumbnail together with the photo itself.
export function removeThumbnail(uploadDir, storedName) {
  fs.unlink(path.join(uploadDir, "thumbs", `${path.basename(storedName)}.jpg`), () => {});
}
