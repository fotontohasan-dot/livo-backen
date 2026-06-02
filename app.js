require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const Match = require('./Match');

const app = express();
const PORT = process.env.PORT || 10000;

// EJS Setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Home Page
app.get('/', async (req, res) => {
    try {
        if (mongoose.connection.readyState !== 1) {
            throw new Error('Database not connected');
        }

        const matches = await Match.find().lean();

        res.render('index', {
            title: 'Livo - Live Casino & Sports',
            matches: matches || [],
            user_count: 1248,
            live_stream: 5,
            game_count: 42
        });

    } catch (err) {
        console.error('Home Route Error:', err);
        res.status(500).send('Internal Server Error');
    }
});

// Add Match
app.post('/admin/add-match', async (req, res) => {
    try {
        await Match.create({
            title: req.body.title,
            status: req.body.status || 'upcoming'
        });

        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.status(500).send('Error saving match');
    }
});

// MongoDB Connect
async function connectDB() {
    try {
        await mongoose.connect(process.env.MONGODB_URI);

        console.log('✅ MongoDB Connected');

        app.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
        });

    } catch (err) {
        console.error('MongoDB Error:', err);
        process.exit(1);
    }
}

connectDB();
