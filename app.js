const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const app = express();
const Match = require('./Match');

app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

// সবচেয়ে নিরাপদ views path
app.set('views', path.join(process.cwd(), 'views'));

console.log("Views path set to:", path.join(process.cwd(), 'views'));

// ডাটাবেস
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Error:', err));

// হোমপেজ
app.get('/', async (req, res) => {
    try {
        const matches = await Match.find();
        res.render('index', { title: "Livo", matches, user_count: 1248, live_stream: 5, game_count: 42 });
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
        res.status(500).send("Admin page এ সমস্যা হচ্ছে");
    }
});

// টেস্ট
app.get('/test', (req, res) => {
    const viewsPath = path.join(process.cwd(), 'views');
    res.json({
        cwd: process.cwd(),
        viewsPath: viewsPath,
        viewsExists: fs.existsSync(viewsPath),
        files: fs.existsSync(viewsPath) ? fs.readdirSync(viewsPath) : "Not found"
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
