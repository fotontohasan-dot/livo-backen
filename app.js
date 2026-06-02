const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const app = express();
const Match = require('./Match');

app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

mongoose.connect(process.env.MONGODB_URI);

app.get('/', async (req, res) => {
    const matches = await Match.find();
    res.render('index', { title: "Livo", matches });
});

// ম্যাচ যোগ করার রাউট
app.post('/admin/add-match', async (req, res) => {
    const newMatch = new Match({
        teamA: req.body.teamA,
        teamB: req.body.teamB,
        oddsA: req.body.oddsA,
        oddsB: req.body.oddsB
    });
    await newMatch.save();
    res.redirect('/');
});
// এই কোডটুকু app.js এর শেষে যোগ করুন
app.get('/admin', (req, res) => {
    res.render('admin');
});

app.listen(process.env.PORT || 3000);
