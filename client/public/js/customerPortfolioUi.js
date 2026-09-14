import { api } from "./api.js";

// Potential and Competitors are portfolio-level channels in filters, not
// operational routing values written into customers.sales_channel. Only
// stand in for a MISSING sales_channel -- a customer an SM has already
// assigned a real channel to (e.g. OEM, PCO) keeps showing that channel
// everywhere even before it's ERP-linked; erp_customer_id alone is not
// reason enough to hide it behind "Potential" (that used to happen here
// unconditionally, which is why the map's channel filter/pins only ever
// showed SM channels + Potential -- every not-yet-ERP-linked customer's
// real channel was being overwritten regardless of whether it had one).
function normalizeCustomer(customer) {
  if (!customer || typeof customer !== "object") return customer;
  const copy = { ...customer };
  if (copy.customer_tier === "competitor") {
    copy.sales_channel = "COMPETITORS";
  } else if (!String(copy.erp_customer_id ?? "").trim() && !String(copy.sales_channel ?? "").trim()) {
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
