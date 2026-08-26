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

// ==================== অ্যাক্সেস নিয়ন্ত্রণ ====================
// এই সার্ভিসটা মূল Express অ্যাপের (app.js) সাথে যুক্ত নয় — আলাদা প্রক্রিয়া।
// কিন্তু কেউ ডিপ্লয় করলে `/api/predict` ছিল সম্পূর্ণ উন্মুক্ত: ক্লায়েন্ট
// নিজেই `userId` পাঠাত এবং সার্ভার সেটা বিশ্বাস করে যেকোনো ইউজারের
// প্রেডিকশন লিখে বা বদলে দিত। প্রমাণীকরণ নেই, রেট-লিমিট নেই।
//
// এখন লেখার রুটে শেয়ার্ড কী বাধ্যতামূলক, আর কী সেট না থাকলে সার্ভিসটা
// একেবারে চালুই হয় না — অরক্ষিত অবস্থায় ভুল করে ডিপ্লয় হওয়া ঠেকাতে।
const SPORTS_API_KEY = process.env.SPORTS_API_KEY || '';

if (!SPORTS_API_KEY) {
  console.error(
    'SPORTS_API_KEY সেট করা নেই। এই সার্ভিসের /api/predict রুট প্রমাণীকরণ ছাড়া ' +
    'চালানো নিরাপদ নয়, তাই সার্ভার চালু করা হলো না।\n' +
    'এটি প্রোডাকশনের অংশ না হলে সার্ভিসটি ডিপ্লয় থেকে বাদ দিন — ' +
    'sports-api/README.md দেখুন।'
  );
  process.exit(1);
}

/** লেখার রুটে শেয়ার্ড-কী যাচাই। পড়ার রুট (স্কোর/ট্যালি) আগের মতোই পাবলিক। */
function requireApiKey(req, res, next) {
  const provided = req.get('x-api-key') || '';
  if (provided !== SPORTS_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

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

// `userId` এখনো বডিতে নেওয়া হয়, কিন্তু রুটটা শুধু কী-ধারী কলার (মূল অ্যাপের
// সার্ভার-সাইড) ব্যবহার করতে পারে — ব্রাউজার সরাসরি নয়। অর্থাৎ পরিচয় আসে
// বিশ্বস্ত সার্ভার থেকে, ক্লায়েন্টের দাবি থেকে নয়।
app.post("/api/predict", requireApiKey, (req, res) => {
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
