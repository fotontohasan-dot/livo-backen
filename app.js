const express = require("express");
const path = require("path");
const mongoose = require("mongoose"); // ডাটাবেজের জন্য দরকার

const app = express();
const PORT = process.env.PORT || 10000;

// মডেল ইমপোর্ট (এখানে যুক্ত করা হয়েছে)
const User = require('./User');
const Match = require('./Match');

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

// Server Start
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
});
