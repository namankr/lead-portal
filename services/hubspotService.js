/**
 * hubspotService.js
 * Encapsulates every call into the HubSpot CRM API.
 *
 * Auth model: this uses a HubSpot Private App access token rather than a
 * full OAuth flow. For a single Developer Sandbox account (one portal,
 * one internal integration) a private app token is the model HubSpot
 * itself recommends -- it's a static bearer token scoped to specific
 * CRM permissions, no redirect/consent screen or token refresh dance
 * required. If this were distributed to multiple HubSpot portals,
 * you'd swap this module for an OAuth 2.0 authorization-code flow
 * (see README "Going from Private App to OAuth").
 */
const { Client } = require("@hubspot/api-client");

const ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN || "";
const DEAL_PIPELINE = process.env.HUBSPOT_DEAL_PIPELINE || "default";
const DEAL_STAGE = process.env.HUBSPOT_DEAL_STAGE || ""; // resolved lazily if blank

let hubspotClient = null;
function getClient() {
  if (!ACCESS_TOKEN) return null;
  if (!hubspotClient) hubspotClient = new Client({ accessToken: ACCESS_TOKEN });
  return hubspotClient;
}

function isConfigured() {
  return Boolean(ACCESS_TOKEN);
}

/**
 * Confirms the token is valid and the API is reachable by pulling a
 * single contact page. This is what backs the dashboard's connection
 * indicator -- it reflects real, current reachability rather than just
 * "a token string is present in .env".
 */
async function checkConnection() {
  if (!isConfigured()) {
    return { connected: false, reason: "HUBSPOT_ACCESS_TOKEN is not set in .env" };
  }
  try {
    const client = getClient();
    await client.crm.contacts.basicApi.getPage(1);
    return { connected: true };
  } catch (err) {
    return { connected: false, reason: extractHubspotError(err) };
  }
}

function extractHubspotError(err) {
  return (
    err?.body?.message ||
    err?.message ||
    "Unknown HubSpot API error"
  );
}

/** Finds an existing contact by email so re-submissions update rather than duplicate. */
async function findContactByEmail(client, email) {
  const result = await client.crm.contacts.searchApi.doSearch({
    filterGroups: [
      { filters: [{ propertyName: "email", operator: "EQ", value: email }] },
    ],
    properties: ["email", "firstname", "lastname", "company"],
    limit: 1,
  });
  return result.results?.[0] || null;
}

/**
 * Upserts a Contact and creates an associated Deal representing the
 * estimated budget, then links the two. Returns sync result details
 * so the caller can persist status back into the local store.
 */
async function syncLeadToHubspot(lead) {
  const client = getClient();
  if (!client) {
    throw new Error("HubSpot client is not configured (missing HUBSPOT_ACCESS_TOKEN)");
  }

  // 1. Upsert the Contact
  const contactProperties = {
    email: lead.email,
    firstname: lead.firstName,
    lastname: lead.lastName,
    company: lead.company,
    // Custom property -- must exist on the Contact object in the target
    // portal (see README "HubSpot setup" for the exact internal name to
    // create). If it doesn't exist yet, HubSpot rejects the whole
    // create/update call, so we retry once without it below.
    estimated_annual_budget: lead.budget,
  };

  let contact;
  const existing = await findContactByEmail(client, lead.email);
  try {
    if (existing) {
      contact = await client.crm.contacts.basicApi.update(existing.id, {
        properties: contactProperties,
      });
    } else {
      contact = await client.crm.contacts.basicApi.create({
        properties: contactProperties,
      });
    }
  } catch (err) {
    // Retry without the custom property in case it hasn't been created
    // in this portal yet -- keeps the sync from hard-failing on a
    // one-time setup step.
    const message = extractHubspotError(err);
    if (message.toLowerCase().includes("estimated_annual_budget")) {
      const { estimated_annual_budget, ...fallbackProps } = contactProperties;
      contact = existing
        ? await client.crm.contacts.basicApi.update(existing.id, { properties: fallbackProps })
        : await client.crm.contacts.basicApi.create({ properties: fallbackProps });
    } else {
      throw err;
    }
  }

  // 2. Create a Deal sized from the budget bracket, associated to the contact
  const dealProperties = {
    dealname: `${lead.company} - ${lead.firstName} ${lead.lastName}`,
    amount: String(lead.budgetValue ?? 0),
    pipeline: DEAL_PIPELINE,
    dealstage: DEAL_STAGE || undefined, // undefined lets HubSpot use the pipeline's default stage
  };
  Object.keys(dealProperties).forEach((k) => dealProperties[k] === undefined && delete dealProperties[k]);

  const deal = await client.crm.deals.basicApi.create({
    properties: dealProperties,
    associations: [
      {
        to: { id: contact.id },
        types: [
          {
            associationCategory: "HUBSPOT_DEFINED",
            associationTypeId: 3, // Deal -> Contact
          },
        ],
      },
    ],
  });

  return {
    contactId: contact.id,
    dealId: deal.id,
  };
}

module.exports = { isConfigured, checkConnection, syncLeadToHubspot, extractHubspotError };
