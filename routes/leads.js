const express = require("express");
const router = express.Router();
const db = require("../services/db");
const hubspot = require("../services/hubspotService");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_BUDGETS = ["Under $10k", "$10k-$50k", "Greater than $50k"];

function validateLeadPayload(body) {
  const errors = [];
  const firstName = (body.firstName || "").trim();
  const lastName = (body.lastName || "").trim();
  const email = (body.email || "").trim();
  const company = (body.company || "").trim();
  const budget = (body.budget || "").trim();

  if (!firstName) errors.push("First name is required.");
  if (!lastName) errors.push("Last name is required.");
  if (!company) errors.push("Company name is required.");
  if (!email) errors.push("Corporate email is required.");
  else if (!EMAIL_RE.test(email)) errors.push("Email address is not valid.");
  if (!budget) errors.push("Estimated annual budget is required.");
  else if (!VALID_BUDGETS.includes(budget)) errors.push("Budget must be one of the listed ranges.");

  return { errors, clean: { firstName, lastName, email, company, budget } };
}

module.exports = function leadsRouter() {
  // POST /api/leads - ingest a new lead, broadcast it live, sync to HubSpot in the background
  router.post("/leads", async (req, res) => {
    const io = req.app.get("io");
    const { errors, clean } = validateLeadPayload(req.body || {});

    if (errors.length) {
      return res.status(400).json({ ok: false, errors });
    }

    // 1. Persist locally first so the form gets a fast, reliable ack
    const lead = await db.insertLead(clean);
    const stored = await db.updateLead(lead.id, { localStatus: "stored" });

    // 2. Push it onto the live dashboard immediately
    io.emit("lead:new", stored);

    res.status(201).json({ ok: true, lead: stored });

    // 3. Sync to HubSpot asynchronously so the form submission never
    // blocks on an external API call
    syncLeadAsync(stored.id, io);
  });

  // GET /api/leads - full lead list for initial dashboard load
  router.get("/leads", async (req, res) => {
    res.json({ ok: true, leads: await db.getLeads() });
  });

  // GET /api/analytics - summary badges
  router.get("/analytics", async (req, res) => {
    res.json({ ok: true, analytics: await db.getAnalytics() });
  });

  // GET /api/hubspot/status - live connection check for the router control panel
  router.get("/hubspot/status", async (req, res) => {
    const status = await hubspot.checkConnection();
    res.json({ ok: true, ...status });
  });

  // POST /api/leads/:id/resync - manual retry from the dashboard
  router.post("/leads/:id/resync", async (req, res) => {
    const io = req.app.get("io");
    const leads = await db.getLeads();
    const lead = leads.find((l) => l.id === req.params.id);
    if (!lead) return res.status(404).json({ ok: false, error: "Lead not found" });
    res.json({ ok: true });
    syncLeadAsync(lead.id, io);
  });

  return router;
};

async function syncLeadAsync(leadId, io) {
  const leads = await db.getLeads();
  const lead = leads.find((l) => l.id === leadId);
  if (!lead) return;

  const syncing = await db.updateLead(leadId, { hubspotStatus: "syncing", syncError: null });
  io.emit("lead:updated", syncing);

  try {
    const { contactId, dealId } = await hubspot.syncLeadToHubspot(lead);
    const synced = await db.updateLead(leadId, {
      hubspotStatus: "synced",
      hubspotContactId: contactId,
      hubspotDealId: dealId,
      syncError: null,
    });
    io.emit("lead:updated", synced);
  } catch (err) {
    const message = hubspot.extractHubspotError(err);
    const failed = await db.updateLead(leadId, { hubspotStatus: "failed", syncError: message });
    io.emit("lead:updated", failed);
  }

  io.emit("analytics:update", await db.getAnalytics());
}
