const socket = io();

const socketIndicator = document.getElementById("socket-indicator");
const socketLabel = document.getElementById("socket-label");
const feedBody = document.getElementById("feed-body");
const emptyRow = document.getElementById("empty-row");
const feedCount = document.getElementById("feed-count");

const badgeTotal = document.getElementById("badge-total");
const badgeValue = document.getElementById("badge-value");
const badgeSynced = document.getElementById("badge-synced");
const badgePending = document.getElementById("badge-pending");
const badgeFailed = document.getElementById("badge-failed");

const routerDot = document.getElementById("router-dot");
const routerTitle = document.getElementById("router-title");
const routerDetail = document.getElementById("router-detail");
const routerRefresh = document.getElementById("router-refresh");
const hubspotNode = document.getElementById("hubspot-node");

let leadsById = new Map();

const currencyFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const STATUS_LABEL = {
  received: "Received",
  stored: "Stored",
  pending: "Pending",
  syncing: "Syncing\u2026",
  synced: "Synced",
  failed: "Failed",
};

// ---------- Socket connection state ----------
socket.on("connect", () => {
  socketIndicator.classList.add("connected");
  socketLabel.textContent = "live";
});

socket.on("disconnect", () => {
  socketIndicator.classList.remove("connected");
  socketLabel.textContent = "disconnected";
});

// ---------- Initial state ----------
socket.on("leads:init", (leads) => {
  leadsById = new Map(leads.map((l) => [l.id, l]));
  renderAll();
});

socket.on("analytics:update", (analytics) => {
  renderAnalytics(analytics);
});

socket.on("hubspot:status", (status) => {
  renderRouterStatus(status);
});

// ---------- Live events ----------
socket.on("lead:new", (lead) => {
  leadsById.set(lead.id, lead);
  renderAll(lead.id);
  animateTrack("form-backend");
  setTimeout(() => animateTrack("backend-dashboard"), 250);
});

socket.on("lead:updated", (lead) => {
  leadsById.set(lead.id, lead);
  renderAll();
  if (lead.hubspotStatus === "syncing") {
    animateTrack("backend-hubspot");
  }
  if (lead.hubspotStatus === "synced") {
    hubspotNode.classList.add("live");
    hubspotNode.classList.remove("down");
  }
  if (lead.hubspotStatus === "failed") {
    hubspotNode.classList.add("down");
  }
});

// ---------- Rendering ----------
function renderAll(highlightId) {
  const leads = Array.from(leadsById.values()).sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  feedCount.textContent = `${leads.length} lead${leads.length === 1 ? "" : "s"}`;

  if (!leads.length) {
    feedBody.innerHTML = "";
    feedBody.appendChild(emptyRow);
    return;
  }

  feedBody.innerHTML = "";
  leads.forEach((lead) => {
    const row = document.createElement("tr");
    if (lead.id === highlightId) row.classList.add("new-row");

    const localChip = statusChip(lead.localStatus, STATUS_LABEL[lead.localStatus] || lead.localStatus);
    const hubspotChip = statusChip(lead.hubspotStatus, STATUS_LABEL[lead.hubspotStatus] || lead.hubspotStatus, lead.syncError);

    row.innerHTML = `
      <td>
        <span class="lead-name">${escapeHtml(lead.firstName)} ${escapeHtml(lead.lastName)}</span>
        <span class="lead-email">${escapeHtml(lead.email)}</span>
      </td>
      <td>${escapeHtml(lead.company)}</td>
      <td>${escapeHtml(lead.budget)}</td>
      <td>${localChip}</td>
      <td>${hubspotChip}${lead.hubspotStatus === "failed" ? `<button class="retry-btn" data-id="${lead.id}">Retry</button>` : ""}</td>
      <td class="lead-email">${timeFmt.format(new Date(lead.createdAt))}</td>
      <td>${lead.hubspotContactId ? `<span class="lead-email">#${escapeHtml(lead.hubspotContactId)}</span>` : ""}</td>
    `;
    feedBody.appendChild(row);
  });

  feedBody.querySelectorAll(".retry-btn").forEach((btn) => {
    btn.addEventListener("click", () => resyncLead(btn.dataset.id));
  });
}

function statusChip(status, label, errorTooltip) {
  const title = errorTooltip ? ` title="${escapeHtml(errorTooltip)}"` : "";
  return `<span class="chip status-${status}"${title}><span class="dot"></span>${escapeHtml(label)}</span>`;
}

function renderAnalytics(analytics) {
  badgeTotal.textContent = analytics.totalLeads;
  badgeValue.textContent = currencyFmt.format(analytics.totalPipelineValue);
  badgeSynced.textContent = analytics.synced;
  badgePending.textContent = analytics.pending;
  badgeFailed.textContent = analytics.failed;
}

function renderRouterStatus(status) {
  if (status.connected) {
    routerDot.className = "status-dot connected";
    routerTitle.textContent = "Connected to HubSpot CRM";
    routerDetail.textContent = "Private app token verified \u2014 leads are routed on submission.";
    hubspotNode.classList.add("live");
    hubspotNode.classList.remove("down");
  } else {
    routerDot.className = "status-dot disconnected";
    routerTitle.textContent = "HubSpot connection unavailable";
    routerDetail.textContent = status.reason || "Unable to reach the HubSpot CRM API.";
    hubspotNode.classList.add("down");
    hubspotNode.classList.remove("live");
  }
}

function animateTrack(name) {
  const track = document.querySelector(`.pipeline-track[data-track="${name}"]`);
  if (!track) return;
  track.classList.remove("active");
  // Force reflow so the animation restarts even if it fired recently
  void track.offsetWidth;
  track.classList.add("active");
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function resyncLead(id) {
  try {
    await fetch(`/api/leads/${id}/resync`, { method: "POST" });
  } catch (err) {
    console.error("Retry request failed", err);
  }
}

routerRefresh.addEventListener("click", async () => {
  routerTitle.textContent = "Checking HubSpot connection\u2026";
  routerDetail.textContent = "Verifying private app token against the CRM API.";
  const res = await fetch("/api/hubspot/status");
  const status = await res.json();
  renderRouterStatus(status);
});

// Kick off an initial REST fetch too, in case the socket handshake is slow
(async () => {
  try {
    const [leadsRes, analyticsRes, statusRes] = await Promise.all([
      fetch("/api/leads").then((r) => r.json()),
      fetch("/api/analytics").then((r) => r.json()),
      fetch("/api/hubspot/status").then((r) => r.json()),
    ]);
    if (leadsRes.ok) {
      leadsById = new Map(leadsRes.leads.map((l) => [l.id, l]));
      renderAll();
    }
    if (analyticsRes.ok) renderAnalytics(analyticsRes.analytics);
    renderRouterStatus(statusRes);
  } catch (err) {
    console.error("Initial dashboard load failed", err);
  }
})();
