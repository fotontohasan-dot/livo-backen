const request = require('supertest');
const app = require('../../app.js');

const REALISTIC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function extractCsrfToken(html) {
  const match = /<meta name="csrf-token" content="([^"]*)"/.exec(html || '');
  return match ? match[1] : '';
}

async function getCsrfAgent(path = '/login') {
  const agent = request.agent(app);
  agent.set('User-Agent', REALISTIC_UA);
  const res = await agent.get(path).set('User-Agent', REALISTIC_UA);
  const token = extractCsrfToken(res.text);
  return { agent, token };
}

function uniqueUsername(prefix = 'tu') {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}${Date.now().toString(36).slice(-6)}${rand}`.slice(0, 20);
}

module.exports = { app, extractCsrfToken, getCsrfAgent, uniqueUsername, REALISTIC_UA };
