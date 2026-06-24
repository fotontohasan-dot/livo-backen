import fetch from "node-fetch";

const BASE = "https://v3.football.api-sports.io";

function headers() {
  return { "x-apisports-key": process.env.FOOTBALL_API_KEY };
}

async function call(path) {
  const res = await fetch(`${BASE}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`Football API ${res.status}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length)
    throw new Error(JSON.stringify(json.errors));
  return json.response;
}

export async function liveMatches() {
  return call(`/fixtures?live=all`);
}

export async function fixturesByDate(date) {
  return call(`/fixtures?date=${date}`);
}

export async function prediction(fixtureId) {
  return call(`/predictions?fixture=${fixtureId}`);
}
