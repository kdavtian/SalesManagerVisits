// Product photos fast (owner, 2026-11-07: "images load too slow"): a phone photo is several MB, and every screen downloaded it again.
// ?w=160|320|800 serves a resized JPEG made once with sharp and kept next to the original (<file>.w<width>.jpg); the photo's address
// never changes for the same file, so the browser keeps it for a year (the main photo's address carries ?v=<file name>, which changes
// when the photo changes).
import fs from "node:fs";
import path from "node:path";
import { uploadDirPath } from "../shared/upload.js";

const WIDTHS = new Set([160, 320, 800]);
const making = new Map(); // one resize per file at a time

async function resized(original, width) {
  const out = `${original}.w${width}.jpg`;
  if (fs.existsSync(out)) return out;
  if (!making.has(out)) {
    making.set(
      out,
      (async () => {
        const sharp = (await import("sharp")).default;
        const tmp = `${out}.${process.pid}.tmp`;
        await sharp(original).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toFile(tmp);
        fs.renameSync(tmp, out);
        return out;
      })().finally(() => making.delete(out))
    );
  }
  return making.get(out);
}

/** Sends one stored product photo (`fileName` under the upload folder), resized when ?w= asks for it. */
export async function sendProductImage(req, res, fileName) {
  const original = path.join(uploadDirPath, path.basename(fileName));
  if (!fs.existsSync(original)) return res.status(404).json({ error: "Image not found" });
  const width = Number(req.query.w);
  let file = original;
  if (WIDTHS.has(width)) {
    try {
      file = await resized(original, width);
    } catch {
      file = original; // not an image sharp can read: the original as it is
    }
  }
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.sendFile(file, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "Image not found" });
  });
}
