const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');   // ← নতুন যোগ করা হয়েছে

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== Middleware ====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== ROOT ROUTE ====================
app.get('/', (req, res) => {
  res.send(`
    <h1>✅ সার্ভার চলছে!</h1>
    <p>তোমার Express + MongoDB অ্যাপ সফলভাবে চালু আছে।</p>
  `);
});

// ==================== FRONTEND সার্ভ করার জন্য (নতুন যোগ করা) ====================
app.use(express.static(path.join(__dirname, 'build')));           // সবচেয়ে কমন — 'build' ফোল্ডার
// app.use(express.static(path.join(__dirname, 'client/build'))); // যদি client/build হয়
// app.use(express.static(path.join(__dirname, 'dist')));         // যদি dist হয়
// app.use(express.static(path.join(__dirname, 'public')));       // যদি public হয়

// React / Vite ফ্রন্টএন্ডের জন্য সব রুট একই index.html এ পাঠানো
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));     // ফোল্ডার অনুযায়ী চেঞ্জ করো
});

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => {
    console.error('MongoDB Connection Error:', err);
    process.exit(1);
  });

// তোমার অন্যান্য রুট এখানে যোগ করবে

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
