/**
 * db.js
 * Minimal, dependency-free persistence layer.
 *
 * A real production system would use Postgres/MySQL, but for this
 * lightweight portal a JSON-backed store keeps the project runnable
 * anywhere with zero native build dependencies while still giving us
 * durable storage across server restarts.
 */
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "leads.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
}

function readAll() {
  ensureStore();
  const raw = fs.readFileSync(DATA_FILE, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeAll(leads) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify(leads, null, 2));
}

/** Budget dropdown -> a representative numeric value used for pipeline analytics. */
const BUDGET_VALUE_MAP = {
  "Under $10k": 5000,
  "$10k-$50k": 30000,
  "Greater than $50k": 75000,
};

function budgetToValue(budgetLabel) {
  return BUDGET_VALUE_MAP[budgetLabel] ?? 0;
}

function insertLead(lead) {
  const leads = readAll();
  const record = {
    id: `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    firstName: lead.firstName,
    lastName: lead.lastName,
    email: lead.email,
    company: lead.company,
    budget: lead.budget,
    budgetValue: budgetToValue(lead.budget),
    localStatus: "received", // received -> validated -> stored
    hubspotStatus: "pending", // pending -> syncing -> synced -> failed
    hubspotContactId: null,
    hubspotDealId: null,
    syncError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  leads.unshift(record);
  writeAll(leads);
  return record;
}

function updateLead(id, patch) {
  const leads = readAll();
  const idx = leads.findIndex((l) => l.id === id);
  if (idx === -1) return null;
  leads[idx] = { ...leads[idx], ...patch, updatedAt: new Date().toISOString() };
  writeAll(leads);
  return leads[idx];
}

function getLeads() {
  return readAll();
}

function getAnalytics() {
  const leads = readAll();
  const totalLeads = leads.length;
  const totalPipelineValue = leads.reduce((sum, l) => sum + (l.budgetValue || 0), 0);
  const synced = leads.filter((l) => l.hubspotStatus === "synced").length;
  const failed = leads.filter((l) => l.hubspotStatus === "failed").length;
  const pending = leads.filter((l) => l.hubspotStatus === "pending" || l.hubspotStatus === "syncing").length;
  return { totalLeads, totalPipelineValue, synced, failed, pending };
}

module.exports = { insertLead, updateLead, getLeads, getAnalytics, budgetToValue, BUDGET_VALUE_MAP };
