import fetch from "node-fetch";

const BASE = "https://api.cricapi.com/v1";

async function call(endpoint, params = {}) {
  const qs = new URLSearchParams({
    apikey: process.env.CRICKET_API_KEY,
    ...params,
  });
  const res = await fetch(`${BASE}/${endpoint}?${qs}`);
  if (!res.ok) throw new Error(`Cricket API ${res.status}`);
  const json = await res.json();
  if (json.status !== "success")
    throw new Error(json.reason || "cricket api error");
  return json.data;
}

export async function currentMatches(offset = 0) {
  return call("currentMatches", { offset });
}

export async function matchInfo(id) {
  return call("match_info", { id });
}

export async function matchScorecard(id) {
  return call("match_scorecard", { id });
}
