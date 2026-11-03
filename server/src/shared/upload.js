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
