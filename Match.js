const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
    teamA: String,
    teamB: String,
    oddsA: Number,
    oddsB: Number,
    status: { type: String, default: 'upcoming' }
});

module.exports = mongoose.model('Match', matchSchema);
