const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();   // ← এটা সবার উপরে রাখো

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== Middleware ====================
app.use(express.json());           // JSON body পার্স করার জন্য
app.use(express.urlencoded({ extended: true }));

// ==================== ROOT ROUTE (নতুন যোগ করা) ====================
app.get('/', (req, res) => {
  res.send(`
    <h1>✅ সার্ভার চলছে!</h1>
    <p>তোমার Express + MongoDB অ্যাপ সফলভাবে চালু আছে।</p>
    <p><strong>Render.com</strong> এ ডিপ্লয় হয়েছে।</p>
  `);
});

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => {
    console.error('MongoDB Connection Error:', err);
    process.exit(1);
  });

// Middleware + Routes ... (তোমার অন্যান্য রুট এখানে যোগ করবে)

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
