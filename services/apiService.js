// services/apiService.js
const axios = require('axios');

const API_KEY = process.env.API_FOOTBALL_KEY; // .env এ রাখবে

const api = axios.create({
  baseURL: 'https://v3.football.api-sports.io',
  headers: {
    'x-apisports-key': API_KEY
  }
});

class SportsAPI {
  async getLiveMatches() {
    try {
      const res = await api.get('/fixtures?live=all');
      return res.data.response;
    } catch (err) {
      console.error(err);
      return [];
    }
  }

  async getCricketMatches() {
    // Cricket API integration
  }
}

module.exports = new SportsAPI();
