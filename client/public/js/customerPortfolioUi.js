import { api } from "./api.js";

// Potential and Competitors are portfolio-level channels in filters, not
// operational routing values written into customers.sales_channel.
function normalizeCustomer(customer) {
  if (!customer || typeof customer !== "object") return customer;
  const copy = { ...customer };
  if (copy.customer_tier === "competitor") {
    copy.sales_channel = "COMPETITORS";
  } else if (!String(copy.erp_customer_id ?? "").trim()) {
    copy.customer_tier = "potential";
    copy.sales_channel = "POTENTIAL";
  }
  return copy;
}

const originalListCustomers = api.listCustomers.bind(api);
const originalGetCustomer = api.getCustomer.bind(api);
const originalCreateCustomer = api.createCustomer.bind(api);
const originalUpdateCustomer = api.updateCustomer.bind(api);

api.listCustomers = async (...args) => {
  const rows = await originalListCustomers(...args);
  return Array.isArray(rows) ? rows.map(normalizeCustomer) : rows;
};
api.getCustomer = async (...args) => normalizeCustomer(await originalGetCustomer(...args));
api.createCustomer = async (data) => normalizeCustomer(await originalCreateCustomer(data));
api.updateCustomer = async (id, data) => normalizeCustomer(await originalUpdateCustomer(id, data));

let scheduled = false;
function applyCustomerFilterPolicy() {
  const row = document.querySelector("#customer-filter-row");
  const subregion = row?.querySelector('[data-filter-btn="subregion"]');
  if (subregion) subregion.remove();
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    applyCustomerFilterPolicy();
  });
}

function boot() {
  schedule();
  const app = document.querySelector("#app");
  if (!app) return;
  const observer = new MutationObserver(schedule);
  observer.observe(app, { childList: true, subtree: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
