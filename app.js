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

// Home & Pages
app.get("/", (req, res) => res.render("index", { title: "Livo", user_count: 1248, live_stream: 5, game_count: 42 }));
app.get("/register", (req, res) => res.render("registration", { title: "Register" }));
app.get("/login", (req, res) => res.render("login", { title: "Login" }));
app.get("/admin", (req, res) => res.render("admin", { title: "Admin" }));
app.get("/create-match", (req, res) => res.render("MatchForm", { title: "Create Match" }));

// Admin Route (নতুন যোগ করা হয়েছে)
app.get('/admin/add-match', (req, res) => res.render('admin', { title: "Add Match" }));
app.post('/admin/add-match', async (req, res) => {
    try {
        const { title, status } = req.body;
        await Match.create({ title, status });
        res.send('ম্যাচ সফলভাবে যোগ হয়েছে!');
    } catch (err) {
        res.status(500).send('Error saving match');
    }
});

// Auth & Logic
app.post("/register", async (req, res) => { /* আপনার রেজিস্টার কোড */ });
app.post("/login", async (req, res) => { /* আপনার লগইন কোড */ });
app.post("/create-match", async (req, res) => { /* আপনার ম্যাচ তৈরির কোড */ });

// Server
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
