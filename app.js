require('dotenv').config();

const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.set("view engine", "ejs");
app.set("views", __dirname);

app.use(express.static(path.join(__dirname, "public")));

// MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch(err => console.log("❌ DB Connection Error:", err));

// Models
const User = require('./User');
const Match = require('./Match');

// Home
app.get("/", (req, res) => {
    res.render("index", {
        title: "Livo - Live Casino & Sports",
        user_count: 1248,
        live_stream: 5,
        game_count: 42
    });
});

// Pages
app.get("/register", (req, res) => {
    res.render("registration", {
        title: "Register - Livo"
    });
});

app.get("/login", (req, res) => {
    res.render("login", {
        title: "Login - Livo"
    });
});

app.get("/admin", (req, res) => {
    res.render("admin", {
        title: "Admin - Livo"
    });
});

app.get("/create-match", (req, res) => {
    res.render("MatchForm", {
        title: "Create Match"
    });
});

// Register
app.post("/register", async (req, res) => {

    try {

        const existingUser = await User.findOne({
            username: req.body.username
        });

        if (existingUser) {
            return res.send(
                "এই ইউজারনেম আগে থেকেই আছে"
            );
        }

        const hashedPassword = await bcrypt.hash(
            req.body.password,
            10
        );

        const user = new User({
            username: req.body.username,
            email: req.body.email,
            password: hashedPassword
        });

        await user.save();

        res.send("রেজিস্ট্রেশন সফল!");

    } catch (err) {

        res.status(500).send(err.message);

    }

});

// Login
app.post("/login", async (req, res) => {

    try {

        const user = await User.findOne({
            username: req.body.username
        });

        if (!user) {
            return res.send(
                "ভুল ইউজারনেম বা পাসওয়ার্ড!"
            );
        }

        const match = await bcrypt.compare(
            req.body.password,
            user.password
        );

        if (!match) {
            return res.send(
                "ভুল ইউজারনেম বা পাসওয়ার্ড!"
            );
        }

        const token = jwt.sign(
            {
                id: user._id,
                username: user.username
            },
            process.env.JWT_SECRET,
            {
                expiresIn: "7d"
            }
        );

        res.json({
            message: "লগইন সফল!",
            token: token
        });

    } catch (err) {

        res.status(500).send(
            "Server Error"
        );

    }

});

// Create Match
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

    res.status(500).send(
        "Internal Server Error"
    );

});

// Server
app.listen(PORT, () => {

    console.log(
        `🚀 Server running on port ${PORT}`
    );

});
