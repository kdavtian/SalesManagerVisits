// Customer documents: the one place that knows who may see / add / change a file and how a row is stored.
import { seesAllCustomerFiles, canManageSignedDocuments } from "../shared/roles.js";

export const FILE_KINDS = ["order_blank", "signed_act", "payment_slip", "other"];

export const FILE_COLUMNS = `f.id, f.customer_id, f.kind, f.mime, f.size_bytes, f.order_ids, f.payment_id, f.checkin_id, f.note, f.version, f.created_at,
  f.created_by, u.name AS user_name, f.ai_status, f.ai_result,
  COALESCE((SELECT array_agg(COALESCE(o.order_code, '#' || o.id) ORDER BY o.id) FROM orders o WHERE o.id = ANY(f.order_ids)), '{}') AS order_codes`;

// SQL that limits a query on customer_files f (joined with customers c) to what this user may see. Appends to params.
export function visibleFilesCondition(user, params) {
  if (seesAllCustomerFiles(user.role)) return "TRUE";
  params.push(user.id);
  const me = `$${params.length}`;
  // A sales rep also sees the documents of the customers assigned to him; a driver only what he added himself.
  return user.role === "sales_manager" ? `(f.created_by = ${me} OR c.assigned_manager_id = ${me})` : `f.created_by = ${me}`;
}

export const canDeleteFile = (user) => canManageSignedDocuments(user.role);
export const canRotateFile = (user, file) => canManageSignedDocuments(user.role) || file.created_by === user.id;

export function parseOrderIds(raw) {
  if (!raw) return [];
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 50);
}
