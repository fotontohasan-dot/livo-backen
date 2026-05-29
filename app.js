const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();   // ← এটা সবার উপরে রাখো

const app = express();
const PORT = process.env.PORT || 3000;   // ← খুব জরুরি

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => {
    console.error('MongoDB Connection Error:', err);
    process.exit(1);   // এটা না থাকলে ভালো
  });

// Middleware + Routes ...

app.listen(PORT, '0.0.0.0', () => {   // '0.0.0.0' Render এর জন্য ভালো
  console.log(`Server running on port ${PORT}`);
});
