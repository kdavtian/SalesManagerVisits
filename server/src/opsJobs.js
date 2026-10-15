// Daily jobs of the operations control (Mon-Fri): the accountant gets a task when today's Excel workbook has not
// arrived by 10:00, and one open task listing what is broken in the data (closed by itself when it is fixed).
import { pool } from "./db/pool.js";
import { yerevanToday } from "./utils/yerevanDate.js";
import { excelStatus, dataScorecard } from "./opsReports.js";
import { createOpsTask, closeOpsTasks, usersWithRole } from "./opsTasks.js";
import { isWorkingDay, minuteOfDay } from "./vaghinak/engine.js";

const CHECK_LABELS = {
  customers_no_channel: "Հաճախորդներ՝ առանց ալիքի",
  customers_no_owner: "Հաճախորդներ՝ առանց պատասխանատուի",
  customers_no_erp_id: "Հաճախորդներ՝ առանց ERP կոդի",
  customers_duplicate_erp_id: "Կրկնվող ERP կոդեր",
  price_below_landing: "Ապրանքներ՝ գինը ինքնարժեքից ցածր",
  price_gold_above_silver: "Ապրանքներ՝ Gold գինը Silver-ից բարձր է",
  products_no_price: "Ակտիվ ապրանքներ՝ առանց գնի",
  products_test_active: "Թեստային ապրանք՝ ակտիվ",
};

async function accountants(db) {
  const ids = await usersWithRole("accountant", db);
  return ids.length ? ids : await usersWithRole("admin", db);
}

export async function runOpsJobs(now = new Date(), db = pool) {
  const day = yerevanToday(now);
  const minute = minuteOfDay(now);
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  const result = { excelTasks: 0, dataTasks: 0 };

  const excel = await excelStatus(db, now);
  if (excel.today_synced) await closeOpsTasks("excel_upload", "Ֆայլը ստացվել է", db);

  const workday = dow >= 1 && dow <= 5 && (await isWorkingDay(db, day));
  if (!workday) return result;

  if (!excel.today_synced && minute >= 10 * 60) {
    for (const id of await accountants(db)) {
      if (await createOpsTask({ kind: "excel_upload", title: "Ուղարկիր այսօրվա Excel ֆայլը (Telegram-ի խմբում)", assigneeId: id, items: ["Առանց այս ֆայլի պարտքը, մնացորդը և գները հնացած են"], db })) result.excelTasks++;
    }
  }
  if (minute >= 10 * 60 + 15) {
    const card = await dataScorecard(db);
    const fixes = card.checks.filter((c) => c.severity === "fix" && c.count > 0 && c.key !== "excel_stale");
    if (!fixes.length) await closeOpsTasks("data_quality", "Տվյալները կարգին են", db);
    else {
      const items = fixes.map((c) => `${CHECK_LABELS[c.key] ?? c.key}՝ ${c.count}${c.samples.length ? ` (${c.samples.slice(0, 3).join(", ")})` : ""}`);
      for (const id of await accountants(db)) if (await createOpsTask({ kind: "data_quality", title: "Ուղղիր տվյալների սխալները", assigneeId: id, items, db })) result.dataTasks++;
    }
  }
  return result;
}

let timer = null;
export function startOpsJobs() {
  if (timer) return;
  timer = setInterval(() => runOpsJobs().catch((err) => console.error("Ops jobs failed:", err.message)), 30 * 60 * 1000);
  timer.unref?.();
}
