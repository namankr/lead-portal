/**
 * db.js
 * Persistence layer with two backends:
 *  - Local dev: JSON file at data/leads.json
 *  - Deployed (Vercel or any host): Upstash Redis via @upstash/redis.
 *    Activated when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set
 *    (populated automatically by the Vercel Upstash Redis integration).
 *    The legacy KV_REST_API_URL / KV_REST_API_TOKEN pair (old Vercel KV stores)
 *    is also accepted as a fallback.
 */
const fs = require("fs");
const path = require("path");

// Use Redis when credentials are present (populated automatically by the
// Vercel Upstash Redis integration, or set manually in .env).
const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const USE_KV = !!(REDIS_URL && REDIS_TOKEN);
const KV_KEY = "leads";

// ──────────── File-based storage (local dev) ────────────
const DATA_DIR = path.join(__dirname, "..", "data");
const DATA_FILE = path.join(DATA_DIR, "leads.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
}

function readAllFile() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeAllFile(leads) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify(leads, null, 2));
}

// ──────────── KV storage (Upstash Redis) ────────────
function getRedis() {
  const { Redis } = require("@upstash/redis");
  return new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
}

async function readAllKV() {
  const val = await getRedis().get(KV_KEY);
  return Array.isArray(val) ? val : [];
}

async function writeAllKV(leads) {
  await getRedis().set(KV_KEY, leads);
}

// ──────────── Unified async API ────────────
async function readAll() {
  return USE_KV ? readAllKV() : readAllFile();
}

async function writeAll(leads) {
  if (USE_KV) return writeAllKV(leads);
  writeAllFile(leads);
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

async function insertLead(lead) {
  const leads = await readAll();
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
  await writeAll(leads);
  return record;
}

async function updateLead(id, patch) {
  const leads = await readAll();
  const idx = leads.findIndex((l) => l.id === id);
  if (idx === -1) return null;
  leads[idx] = { ...leads[idx], ...patch, updatedAt: new Date().toISOString() };
  await writeAll(leads);
  return leads[idx];
}

async function getLeads() {
  return readAll();
}

async function getAnalytics() {
  const leads = await readAll();
  const totalLeads = leads.length;
  const totalPipelineValue = leads.reduce((sum, l) => sum + (l.budgetValue || 0), 0);
  const synced = leads.filter((l) => l.hubspotStatus === "synced").length;
  const failed = leads.filter((l) => l.hubspotStatus === "failed").length;
  const pending = leads.filter((l) => l.hubspotStatus === "pending" || l.hubspotStatus === "syncing").length;
  return { totalLeads, totalPipelineValue, synced, failed, pending };
}

module.exports = { insertLead, updateLead, getLeads, getAnalytics, budgetToValue, BUDGET_VALUE_MAP };
