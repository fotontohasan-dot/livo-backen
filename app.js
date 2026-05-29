const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== FRONTEND সার্ভ করা ====================
app.use(express.static(path.join(__dirname, 'build')));        // প্রথমে build চেক করবে
app.use(express.static(path.join(__dirname, 'dist')));         // তারপর dist

// সব রুটে index.html পাঠানো
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'))
    .catch(() => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
});

// ROOT ROUTE (টেস্ট)
app.get('/', (req, res) => {
  res.send('<h1>✅ সার্ভার চলছে</h1>');
});

// MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => {
    console.error('MongoDB Error:', err);
    process.exit(1);
  });

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
