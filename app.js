const express = require("express");
const path = require("path");
const app = express();

// ভিউ ইঞ্জিন হিসেবে EJS সেটআপ
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");

// বডি পার্সার এবং স্ট্যাটিক ফাইল মিডলওয়্যার
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

// ডেমো ডেটা সহ হোম পেজের রুট লজিক
app.get("/", (req, res) => {
  res.render("index", {
    title: "Livo999 - Live Casino & Sports",
    user_count: 1420,
    live_stream_count: 5,
    pending_bet_count: 12,
    game_count: 6,
    book_count: 45,
    book_instance_available_count: 18
  });
});

// অ্যাডমিন প্যানেলের রুট লজিক
app.get("/admin.html", (req, res) => {
  res.send("<h1>Welcome to Admin Panel</h1><p>এখানে আপনার ইউজারদের আইডি ট্র্যাক এবং ব্যালেন্স কন্ট্রোল করতে পারবেন।</p>");
});

// পোর্ট সেটআপ (Render.com এর জন্য এটি জরুরি)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
