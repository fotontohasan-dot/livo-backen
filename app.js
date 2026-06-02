require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const Match = require('./Match'); 

const app = express();
const PORT = process.env.PORT || 10000; // রেন্ডারের জন্য পোর্ট ১০০০০ ভালো

// কনফিগারেশন চেক
console.log("Environment check - PORT:", PORT);
if (!process.env.MONGODB_URI) {
  console.error("CRITICAL ERROR: MONGODB_URI is not set in Environment Variables!");
}

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// MongoDB Connection with Error Handling
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected Successfully');
  } catch (err) {
    console.error('❌ MongoDB Connection Error:', err.message);
  }
};
connectDB();

// Routes
app.get('/', async (req, res) => {
  try {
    // ডাটাবেস কানেকশন চেক
    if (mongoose.connection.readyState !== 1) {
      throw new Error("Database not connected");
    }
    const matches = await Match.find() || [];
    res.render('index', { 
      title: "Livo - Live Casino & Sports",
      matches: matches,
      user_count: 1248,
      live_stream: 5,
      game_count: 42
    });
  } catch (err) {
    console.error("Home Route Error:", err);
    res.status(500).send("Server Error: Database connection failed.");
  }
});

// Admin & Auth routes...
app.get('/admin', (req, res) => res.render('admin/dashboard', { title: "Admin Dashboard - Livo" }));

app.post('/admin/add-match', async (req, res) => {
  try {
    await Match.create({ title: req.body.title, status: req.body.status });
    res.redirect('/');
  } catch (err) {
    res.status(500).send('Error saving match');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Livo Server running on port ${PORT}`);
});
