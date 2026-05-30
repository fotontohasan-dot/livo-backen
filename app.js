const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 10000;

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
