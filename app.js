const express = require("express");
const path = require("path");
const app = express();

// ভিউ ইঞ্জিন সেট করা
app.set("view engine", "ejs");

// এটিই সবচেয়ে গুরুত্বপূর্ণ লাইন: 
// এটি সার্ভারকে বলবে ফাইলগুলো মেইন ফোল্ডার থেকেই নিতে, আলাদা কোনো 'views' ফোল্ডার খোঁজার দরকার নেই।
app.set("views", __dirname); 

const indexRouter = require("./index");
app.use("/", indexRouter);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Livo Server running on http://localhost:${PORT}`);
});
