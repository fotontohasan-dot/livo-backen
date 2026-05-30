const express = require("express");
const path = require("path");
const app = express();

// ভিউ ইঞ্জিন হিসেবে EJS সেট করা
app.set("view engine", "ejs");

// এটিই আসল সমাধান: ফাইলগুলো কোথায় আছে তা সার্ভারকে বলে দেওয়া
app.set("views", __dirname); 

// আপনার রাউট ফাইল কানেক্ট করা
const indexRouter = require("./index");
app.use("/", indexRouter);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
