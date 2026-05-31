require('dotenv').config(); // লোকাল পিসির জন্য জরুরি
const express = require("express");
const path = require("path");
const mongoose = require("mongoose");

const app = express();
const PORT = process.env.PORT || 10000;

// ডাটাবেজ কানেকশন - এখানে process.env.MONGO_URI ব্যবহার করছি
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.log("❌ DB Connection Error:", err));

// মডেল ইমপোর্ট
const User = require('./User');
const Match = require('./Match');

// মিডলওয়্যার
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.set("views", __dirname); // ফাইলগুলো এই ফোল্ডারেই আছে
app.use(express.static(path.join(__dirname, "public")));

// রুটসমূহ
app.get("/", (req, res) => res.render("index"));
app.get("/register", (req, res) => res.render("registration"));
app.get("/login", (req, res) => res.render("login"));
app.get("/admin", (req, res) => res.render("admin"));
app.get("/create-match", (req, res) => res.render("MatchForm"));

// POST রুটসমূহ
app.post("/register", async (req, res) => {
    try {
        await new User(req.body).save();
        res.send("রেজিস্ট্রেশন সফল!");
    } catch (err) { res.status(500).send(err.message); }
});

app.post("/login", async (req, res) => {
    const user = await User.findOne({ username: req.body.username, password: req.body.password });
    user ? res.send("লগইন সফল!") : res.send("ভুল ইউজারনেম বা পাসওয়ার্ড!");
});

app.post("/create-match", async (req, res) => {
    try {
        await new Match(req.body).save();
        res.send("ম্যাচ তৈরি হয়েছে!");
    } catch (err) { res.status(500).send(err.message); }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
