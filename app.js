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
