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
