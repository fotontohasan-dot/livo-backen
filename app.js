const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const app = express();
const Match = require('./Match');

app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

// Views path — src এর ভিতরে views ফোল্ডার
app.set('views', path.join(__dirname, 'views'));

console.log("✅ Views path set to:", app.get('views'));
console.log("Views folder exists?", fs.existsSync(app.get('views')));

// ডাটাবেস
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// হোমপেজ
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
    } catch (err) {
        console.error(err);
        res.status(500).send("সার্ভার এরর");
    }
});

// অ্যাডমিন
app.get('/admin', (req, res) => {
    try {
        res.render('admin');
    } catch (err) {
        console.error("Admin Error:", err.message);
        res.status(500).send("Admin page লোড করতে সমস্যা");
    }
});

// টেস্ট
app.get('/test', (req, res) => {
    res.json({
        cwd: process.cwd(),
        __dirname: __dirname,
        viewsPath: app.get('views'),
        viewsExists: fs.existsSync(app.get('views')),
        files: fs.existsSync(app.get('views')) ? fs.readdirSync(app.get('views')) : "Not found"
    });
});

// ম্যাচ যোগ
app.post('/admin/add-match', async (req, res) => {
    try {
        const newMatch = new Match({
            teamA: req.body.teamA,
            teamB: req.body.teamB,
            oddsA: parseFloat(req.body.oddsA || 0),
            oddsB: parseFloat(req.body.oddsB || 0)
        });
        await newMatch.save();
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.status(500).send("ম্যাচ সেভ করতে সমস্যা হয়েছে");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
