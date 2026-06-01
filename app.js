require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const Match = require('./Match'); 

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ MongoDB Error:', err));

// Routes
// ১. হোমপেজ রাউট (এখানে ম্যাচ ডাটা লোড হচ্ছে)
app.get('/', async (req, res) => {
  try {
    const matches = await Match.find() || [];
    console.log("Matches found:", matches);
    res.render('index', { 
      title: "Livo - Live Casino & Sports",
      matches: matches,
      user_count: 1248,
      live_stream: 5,
      game_count: 42
    });
  } catch (err) {
    console.error("Error:", err);
    res.status(500).send("Server Error");
  }
});

// ২. লগইন ও অ্যাডমিন রাউট
app.get('/login', (req, res) => res.render('login', { title: "Login - Livo" }));
app.get('/admin', (req, res) => res.render('admin/dashboard', { title: "Admin Dashboard - Livo" }));

// ৩. ম্যাচ যোগ করার রুট
app.post('/admin/add-match', async (req, res) => {
  try {
    const { title, status } = req.body;
    await Match.create({ title, status });
    res.redirect('/');
  } catch (err) {
    res.status(500).send('Error saving match');
  }
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username && password) {
    res.redirect('/admin');
  } else {
    res.send('Invalid credentials');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Livo Server running on http://localhost:${PORT}`);
});
