import "dotenv/config";
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import { fileURLToPath } from "url";
import path from "path";

import * as football from "./football.js";
import * as cricket from "./cricket.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const cache = { football: [], cricket: [] };
const predictions = {};

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach((c) => c.readyState === 1 && c.send(msg));
}

async function pollFootball() {
  try {
    cache.football = await football.liveMatches();
    broadcast("football", cache.football);
  } catch (e) {
    console.error("football poll:", e.message);
  }
}
async function pollCricket() {
  try {
    cache.cricket = await cricket.currentMatches();
    broadcast("cricket", cache.cricket);
  } catch (e) {
    console.error("cricket poll:", e.message);
  }
}

setInterval(pollFootball, Number(process.env.POLL_INTERVAL_FOOTBALL) || 60000);
setInterval(pollCricket, Number(process.env.POLL_INTERVAL_CRICKET) || 60000);
pollFootball();
pollCricket();

app.get("/api/football/live", (_, res) => res.json(cache.football));
app.get("/api/cricket/live", (_, res) => res.json(cache.cricket));

app.get("/api/football/prediction/:fixtureId", async (req, res) => {
  try {
    res.json(await football.prediction(req.params.fixtureId));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/cricket/match/:id", async (req, res) => {
  try {
    res.json(await cricket.matchInfo(req.params.id));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/predict", (req, res) => {
  const { matchId, userId, pick } = req.body;
  if (!matchId || !userId || !pick)
    return res.status(400).json({ error: "matchId, userId, pick required" });
  predictions[matchId] = predictions[matchId] || {};
  predictions[matchId][userId] = pick;
  res.json({ ok: true });
  broadcast("predictions", { matchId, tally: tally(matchId) });
});

app.get("/api/predict/:matchId", (req, res) =>
  res.json({ matchId: req.params.matchId, tally: tally(req.params.matchId) })
);

function tally(matchId) {
  const m = predictions[matchId] || {};
  const out = {};
  for (const pick of Object.values(m)) out[pick] = (out[pick] || 0) + 1;
  return out;
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "football", data: cache.football }));
  ws.send(JSON.stringify({ type: "cricket", data: cache.cricket }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
