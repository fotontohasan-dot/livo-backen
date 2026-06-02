require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const Match = require('./Match');

const app = express();
const PORT = process.env.PORT || 10000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) throw new Error("Database not connected");
    const matches = await Match.find().lean() || [];
    res.render('index', { title: "Livo - Live Casino & Sports", matches });
  } catch (err) {
    res.status(500).send("Server Error: " + err.message);
  }
});

app.post('/admin/add-match', async (req, res) => {
  try {
    await Match.create({ title: req.body.title, status: req.body.status || 'upcoming' });
    res.redirect('/');
  } catch (err) {
    res.status(500).send('Error saving match');
  }
});

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ MongoDB Connected');
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};
connectDB();
