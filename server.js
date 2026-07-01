require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const db = require("./services/db");
const hubspot = require("./services/hubspotService");
const leadsRouter = require("./routes/leads");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.set("io", io);
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use("/api", leadsRouter());

app.get("/healthz", (req, res) => res.json({ ok: true }));

io.on("connection", async (socket) => {
  // Bring a freshly-opened dashboard tab up to date immediately
  socket.emit("leads:init", db.getLeads());
  socket.emit("analytics:update", db.getAnalytics());
  socket.emit("hubspot:status", await hubspot.checkConnection());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Lead Distribution Portal running at http://localhost:${PORT}`);
  console.log(`  Public form:      http://localhost:${PORT}/`);
  console.log(`  Ops dashboard:    http://localhost:${PORT}/dashboard.html`);
  console.log(
    hubspot.isConfigured()
      ? "  HubSpot: token detected, will sync leads on submission."
      : "  HubSpot: HUBSPOT_ACCESS_TOKEN not set -- leads will store locally only. See .env.example."
  );
});
