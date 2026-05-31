const express = require("express");
const path = require("path");
const mongoose = require("mongoose");

const app = express();
const PORT = process.env.PORT || 10000;

// মডেল ইমপোর্ট
const User = require('./User');
const Match = require('./Match');

// ডাটা প্রসেস করার জন্য
app.use(express.urlencoded({ extended: true }));

// EJS সেটআপ
app.set("view engine", "ejs");
app.set("views", __dirname);

// Static files
app.use(express.static(path.join(__dirname, "public")));

// Home Page
app.get("/", (req, res) => {
    res.render("index");
});

// Admin Page
app.get("/admin", (req, res) => {
    res.render("admin");
});

// রেজিস্ট্রেশন রুট
app.post("/register", async (req, res) => {
    try {
        const newUser = new User(req.body);
        await newUser.save();
        res.send("রেজিস্ট্রেশন সফল হয়েছে!");
    } catch (err) {
        res.status(500).send("ইরর হয়েছে: " + err.message);
    }
});

// Server Start
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
app.get("/register", (req, res) => {
    res.render("registration");
});
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.log("❌ DB Connection Error:", err));
// লগইন রুট
app.post("/login", async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    if (user) {
        res.send("লগইন সফল হয়েছে! স্বাগতম " + username);
    } else {
        res.send("ভুল ইউজারনেম বা পাসওয়ার্ড!");
    }
});
// ম্যাচ তৈরির ফর্ম দেখানোর জন্য
app.get("/create-match", (req, res) => {
    res.render("MatchForm");
});

// ম্যাচ সেভ করার জন্য
app.post("/create-match", async (req, res) => {
    try {
        const newMatch = new Match(req.body);
        await newMatch.save();
        res.send("ম্যাচ সফলভাবে তৈরি হয়েছে!");
    } catch (err) {
        res.status(500).send("ইরর: " + err.message);
    }
});


