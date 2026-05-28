const express = require("express");
const path = require("path");
const app = express();

// ভিউ ইঞ্জিন হিসেবে EJS সেট করা
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// রাউট ফাইল লিংক করা
const indexRouter = require("./routes/index");
app.use("/", indexRouter);

// সার্ভার পোর্ট সেট করা
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
