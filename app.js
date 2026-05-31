require('dotenv').config();
const express = require("express");
const path = require("path");
const mongoose = require("mongoose");

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set("view engine", "ejs");
app.set("views", __dirname);           // তোমার সেটিং অনুযায়ী
app.use(express.static(path.join(__dirname, "public")));

// MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.log("❌ DB Connection Error:", err));

// মডেল
const User = require('./User');
const Match = require('./Match');

// Routes
app.get("/", (req, res) => {
    res.render("index", { 
        title: "Livo - Live Casino & Sports",
        user_count: 1248,
        live_stream: 5,
        game_count: 42
    });
});

app.get("/register", (req, res) => res.render("registration", { title: "Register - Livo" }));
app.get("/login", (req, res) => res.render("login", { title: "Login - Livo" }));
app.get("/admin", (req, res) => res.render("admin", { title: "Admin - Livo" }));
app.get("/create-match", (req, res) => res.render("MatchForm", { title: "Create Match" }));

// POST Routes
app.post("/register", async (req, res) => {
    try {
        await new User(req.body).save();
        res.send("রেজিস্ট্রেশন সফল!");
    } catch (err) { 
        res.status(500).send(err.message); 
    }
});

app.post("/login", async (req, res) => {
    try {
        const user = await User.findOne({ 
            username: req.body.username, 
            password: req.body.password 
        });
        user ? res.send("লগইন সফল!") : res.send("ভুল ইউজারনেম বা পাসওয়ার্ড!");
    } catch (err) {
        res.status(500).send("Server Error");
    }
});

app.post("/create-match", async (req, res) => {
    try {
        await new Match(req.body).save();
        res.send("ম্যাচ তৈরি হয়েছে!");
    } catch (err) { 
        res.status(500).send(err.message); 
    }
});

// Error Handler
app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).send("Internal Server Error");
});

app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
