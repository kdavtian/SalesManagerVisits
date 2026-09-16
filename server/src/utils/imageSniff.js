import fs from "node:fs";

// Real content-based validation, on top of multer's fileFilter (which only
// ever sees the client-declared Content-Type header -- trivially spoofed,
// e.g. renaming an arbitrary file to end in .jpg). multer's diskStorage
// streams the file to disk as it's received, so fileFilter itself never has
// the bytes to check; this reads the first few bytes back off disk right
// after the upload completes, before the route does anything else with it.
const SIGNATURES = {
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
};

// WebP's magic bytes aren't a single fixed prefix -- "RIFF" at offset 0,
// then a 4-byte length, then "WEBP" at offset 8 -- so it gets its own check
// rather than fitting the SIGNATURES table shape.
function isWebp(buf) {
  return buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP";
}

// True only if the file's actual leading bytes match what `mimetype` claims
// (the exact set upload.js's ALLOWED_MIME_TO_EXT allows). Reads a small,
// fixed-size chunk regardless of the file's real size, so this stays cheap
// even at the 8MB photo limit.
export function matchesDeclaredImageType(filePath, mimetype) {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(12);
    const bytesRead = fs.readSync(fd, buf, 0, 12, 0);
    if (mimetype === "image/webp") return isWebp(buf.subarray(0, bytesRead));
    const sigs = SIGNATURES[mimetype];
    if (!sigs) return false;
    return sigs.some((sig) => bytesRead >= sig.length && sig.every((byte, i) => buf[i] === byte));
  } finally {
    fs.closeSync(fd);
  }
}
