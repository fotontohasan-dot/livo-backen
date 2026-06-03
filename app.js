const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const session = require('express-session');

const app = express();
const Match = require('./Match');
const User = require('./User');

app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

console.log("✅ Views path set to:", app.get('views'));
console.log("Views folder exists?", fs.existsSync(app.get('views')));

app.use(session({
    secret: 'livo_secret_key',
    resave: false,
    saveUninitialized: false
}));

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

// রেজিস্ট্রেশন পেজ
app.get('/register', (req, res) => res.render('registration'));

// রেজিস্ট্রেশন submit
app.post('/register', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const existing = await User.findOne({ email });
        if (existing) return res.render('registration', { error: 'এই ইমেইল আগে থেকে আছে!' });
        const hashed = await bcrypt.hash(password, 10);
        const user = new User({ username, email, password: hashed });
        await user.save();
        req.session.userId = user._id;
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.status(500).send("রেজিস্ট্রেশন সমস্যা");
    }
});

// লগইন পেজ
app.get('/login', (req, res) => res.render('login'));

// লগইন submit
app.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user) return res.render('login', { error: 'ইউজার পাওয়া যায়নি!' });
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.render('login', { error: 'পাসওয়ার্ড ভুল!' });
        req.session.userId = user._id;
        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.status(500).send("লগইন সমস্যা");
    }
});

// লগআউট
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
