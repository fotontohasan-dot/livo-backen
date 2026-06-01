require('dotenv').config();
const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 10000;

// Models
const User = require('./User');
const Match = require('./Match');

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set("view engine", "ejs");
app.set("views", __dirname);
app.use(express.static(path.join(__dirname, "public")));

// MongoDB
mongoose.connect(process.env.MONGO_URI, { dbName: 'sports_prediction' })
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.log("❌ DB Error:", err));

// --- ROUTES ---

// Home - ডাইনামিক ম্যাচসহ
app.get("/", async (req, res) => {
    try {
        const matches = await Match.find();
        res.render("index", { title: "Livo", matches });
    } catch (err) {
        res.status(500).send("ডাটা লোড করতে সমস্যা হয়েছে");
    }
});

app.get("/register", (req, res) => res.render("registration", { title: "Register" }));
app.get("/login", (req, res) => res.render("login", { title: "Login" }));
app.get("/admin", (req, res) => res.render("admin", { title: "Admin" }));

// Admin Route
app.get('/admin/add-match', (req, res) => res.render('admin', { title: "Add Match" }));
app.post('/admin/add-match', async (req, res) => {
    try {
        const { title, status } = req.body;
        await Match.create({ title, status });
        res.redirect('/'); // ম্যাচ যোগ করে হোমপেজে রিডাইরেক্ট করবে
    } catch (err) {
        res.status(500).send('Error saving match');
    }
});

// Auth & Logic
app.post("/register", async (req, res) => { /* আপনার কোড */ });
app.post("/login", async (req, res) => { /* আপনার কোড */ });

// Server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
