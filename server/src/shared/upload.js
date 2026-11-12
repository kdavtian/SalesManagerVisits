import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import multer from "multer";

const uploadDir = path.resolve(process.env.UPLOAD_DIR || "./uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_MIME_TO_EXT = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = ALLOWED_MIME_TO_EXT[file.mimetype] || "bin";
    cb(null, `${crypto.randomUUID()}.${ext}`);
  },
});

export const uploadDirPath = uploadDir;

// A check-in also carries one voice note (owner, 2026-11-12): the audio formats phones record -- iPhone Safari writes MP4/AAC, Android
// Chrome WebM/Opus -- are accepted for that one field only; every other field stays photos-only.
export const VOICE_MIME_TO_EXT = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};
export const VOICE_FIELD = "voice_note";
const baseMime = (m) => String(m || "").split(";")[0].trim().toLowerCase();
const checkinStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = file.fieldname === VOICE_FIELD ? VOICE_MIME_TO_EXT[baseMime(file.mimetype)] || "bin" : ALLOWED_MIME_TO_EXT[file.mimetype] || "bin";
    cb(null, `${crypto.randomUUID()}.${ext}`);
  },
});
export const checkinUpload = multer({
  storage: checkinStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // a voice note of an odd type is left out, never the reason a visit (with its money and photos) is refused
    if (file.fieldname === VOICE_FIELD) {
      if (VOICE_MIME_TO_EXT[baseMime(file.mimetype)]) return cb(null, true);
      req.voiceNoteRejected = true;
      return cb(null, false);
    }
    if (!ALLOWED_MIME_TO_EXT[file.mimetype]) return cb(new Error("Only JPEG, PNG or WebP photos are allowed"));
    cb(null, true);
  },
});

// The container an audio file really is, from its first bytes (multer only sees the declared type): { mime, ext } or null. WebM/Matroska,
// MP4/M4A ("ftyp" box), Ogg, RIFF/WAVE, MP3 (ID3 tag or an MPEG audio frame). Raw ADTS AAC is refused: the speech service does not take it.
export function sniffAudio(filePath) {
  let head;
  try {
    const fd = fs.openSync(filePath, "r");
    head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
  } catch {
    return null;
  }
  if (head.readUInt32BE(0) === 0x1a45dfa3) return { mime: "audio/webm", ext: "webm" }; // EBML (WebM)
  if (head.toString("latin1", 4, 8) === "ftyp") return { mime: "audio/mp4", ext: "m4a" }; // MP4 / M4A
  if (head.toString("latin1", 0, 4) === "OggS") return { mime: "audio/ogg", ext: "ogg" };
  if (head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WAVE") return { mime: "audio/wav", ext: "wav" };
  if (head.toString("latin1", 0, 3) === "ID3") return { mime: "audio/mpeg", ext: "mp3" };
  // an MPEG audio frame: 11 sync bits, then a layer that is not "reserved" (ADTS AAC has layer bits 00)
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0) return { mime: "audio/mpeg", ext: "mp3" };
  return null;
}

export const photoUpload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TO_EXT[file.mimetype]) {
      return cb(new Error("Only JPEG, PNG or WebP photos are allowed"));
    }
    cb(null, true);
  },
});

// Proof-of-Delivery signatures -- a separate directory from checkin photos
// (see migrations/050_warehouse_delivery.sql's pod_records table) even
// though both ultimately live under the same upload volume, so a future
// archiving job can target one or the other independently.
const signatureDir = path.join(uploadDir, "signatures");
fs.mkdirSync(signatureDir, { recursive: true });

const signatureStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, signatureDir),
  filename: (req, file, cb) => {
    const ext = ALLOWED_MIME_TO_EXT[file.mimetype] || "png";
    cb(null, `${crypto.randomUUID()}.${ext}`);
  },
});

export const signatureUpload = multer({
  storage: signatureStorage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME_TO_EXT[file.mimetype]) {
      return cb(new Error("Only JPEG, PNG or WebP signature images are allowed"));
    }
    cb(null, true);
  },
});

// The stock count's signature (a PNG drawn on the phone) and the optional photo / PDF of the paper count (owner, 2026-11-03).
const stockCountDir = path.join(uploadDir, "stock-count");
fs.mkdirSync(stockCountDir, { recursive: true });
const STOCK_COUNT_MIME = { ...ALLOWED_MIME_TO_EXT, "application/pdf": "pdf" };
export const stockCountDirPath = stockCountDir;
export const stockCountUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, stockCountDir),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.${STOCK_COUNT_MIME[file.mimetype] || "bin"}`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => {
    // the signature is an image; the attachment may also be a PDF
    const ok = file.fieldname === "attachment" ? STOCK_COUNT_MIME[file.mimetype] : ALLOWED_MIME_TO_EXT[file.mimetype];
    if (!ok) return cb(new Error("Only JPEG, PNG or WebP images (and a PDF for the attachment) are allowed"));
    cb(null, true);
  },
});
