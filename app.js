const express = require("express");
const path = require("path");
const app = express();

// ভিউ ইঞ্জিন হিসেবে EJS সেট করা
app.set("view engine", "ejs");
app.set("views", __dirname); // সরাসরি মেইন ডিরেক্টরি চুজ করা হলো

// রাউট ফাইল লিংক করা (ফোল্ডার ছাড়া সরাসরি নতুন কোড)
const indexRouter = require("./index"); 
app.use("/", indexRouter);

// সার্ভার পোর্ট সেট করা
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
