const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const app = express();
const Match = require('./Match');

app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ডাটাবেস কানেকশন
mongoose.connect(process.env.MONGODB_URI);

// হোমপেজ রাউট
app.get('/', async (req, res) => {
    try {
        const matches = await Match.find();
        res.render('index', { 
            title: "Livo", 
            matches, 
            user_count: 1248, 
            live_stream: 5, 
            game_count: 42 
        });
    } catch (err) { res.status(500).send("সার্ভার এরর"); }
});

// অ্যাডমিন পেজ রাউট
app.get('/admin', (req, res) => {
    res.render('admin');
});

// ম্যাচ যোগ করার রাউট
app.post('/admin/add-match', async (req, res) => {
    try {
        const newMatch = new Match({
            teamA: req.body.teamA,
            teamB: req.body.teamB,
            oddsA: req.body.oddsA,
            oddsB: req.body.oddsB
        });
        await newMatch.save();
        res.redirect('/');
    } catch (err) { res.status(500).send("ম্যাচ সেভ করতে সমস্যা হয়েছে"); }
});

app.listen(process.env.PORT || 3000);
