require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

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
app.get('/', (req, res) => {
  res.render('index', { 
    title: "Livo - Live Casino & Sports",
    user_count: 1248,
    live_stream: 5,
    game_count: 42
  });
});

app.get('/login', (req, res) => {
  res.render('login', { title: "Login - Livo" });
});

app.get('/live-games', (req, res) => {
  res.render('games/live', { 
    title: "Live Games - Livo" 
  });
});

// Admin Panel
app.get('/admin', (req, res) => {
  res.render('admin/dashboard', { 
    title: "Admin Dashboard - Livo" 
  });
});

// POST Login (এখন শুধু ডেমো)
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  // পরে রিয়েল অথেনটিকেশন যোগ করব
  if (username && password) {
    res.redirect('/admin');
  } else {
    res.send('Invalid credentials');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Livo Server running on http://localhost:${PORT}`);
});
