const express = require("express");
const path = require("path");
const app = express();

// ভিউ ইঞ্জিন হিসেবে EJS সেট করা
app.set("view engine", "ejs");

// এটিই আপনার সমস্যার আসল সমাধান:
// এটি রেন্ডারকে বলে দিচ্ছে যে ফাইলগুলো 'views' ফোল্ডারে নেই, বরং মেইন ফোল্ডারেই আছে
app.set("views", __dirname); 

const indexRouter = require("./index");
app.use("/", indexRouter);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Livo Server running on http://localhost:${PORT}`);
});
