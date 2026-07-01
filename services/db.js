/**
 * db.js
 * Persistence layer backed by Supabase (PostgreSQL).
 * Requires two environment variables:
 *   SUPABASE_URL   — your project URL  (https://<ref>.supabase.co)
 *   SUPABASE_KEY   — service_role secret key (never the anon key in a server process)
 *
 * Run the following SQL once in the Supabase SQL editor to create the table:
 *
 *   CREATE TABLE leads (
 *     id               TEXT PRIMARY KEY,
 *     "firstName"      TEXT NOT NULL,
 *     "lastName"       TEXT NOT NULL,
 *     email            TEXT NOT NULL,
 *     company          TEXT NOT NULL,
 *     budget           TEXT NOT NULL,
 *     "budgetValue"    INTEGER NOT NULL DEFAULT 0,
 *     "localStatus"    TEXT NOT NULL DEFAULT 'received',
 *     "hubspotStatus"  TEXT NOT NULL DEFAULT 'pending',
 *     "hubspotContactId" TEXT,
 *     "hubspotDealId"  TEXT,
 *     "syncError"      TEXT,
 *     "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT now(),
 *     "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT now()
 *   );
 */
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error(
    "Missing Supabase credentials. Set SUPABASE_URL and SUPABASE_KEY environment variables."
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const TABLE = "leads";

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
  const record = {
    id: `lead_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    firstName: lead.firstName,
    lastName: lead.lastName,
    email: lead.email,
    company: lead.company,
    budget: lead.budget,
    budgetValue: budgetToValue(lead.budget),
    localStatus: "received",
    hubspotStatus: "pending",
    hubspotContactId: null,
    hubspotDealId: null,
    syncError: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const { data, error } = await supabase.from(TABLE).insert(record).select().single();
  if (error) throw new Error(`Supabase insertLead: ${error.message}`);
  return data;
}

async function updateLead(id, patch) {
  const { data, error } = await supabase
    .from(TABLE)
    .update({ ...patch, updatedAt: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(`Supabase updateLead: ${error.message}`);
  return data;
}

async function getLeads() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("createdAt", { ascending: false });
  if (error) throw new Error(`Supabase getLeads: ${error.message}`);
  return data;
}

async function getAnalytics() {
  const leads = await getLeads();
  const totalLeads = leads.length;
  const totalPipelineValue = leads.reduce((sum, l) => sum + (l.budgetValue || 0), 0);
  const synced = leads.filter((l) => l.hubspotStatus === "synced").length;
  const failed = leads.filter((l) => l.hubspotStatus === "failed").length;
  const pending = leads.filter((l) => l.hubspotStatus === "pending" || l.hubspotStatus === "syncing").length;
  return { totalLeads, totalPipelineValue, synced, failed, pending };
}

module.exports = { insertLead, updateLead, getLeads, getAnalytics, budgetToValue, BUDGET_VALUE_MAP };
