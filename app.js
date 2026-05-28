const express = require("express");
const app = express();
const path = require("path");

app.set("view engine", "ejs"); // এটা খুব জরুরি
app.set("views", __dirname);   // এটি আপনার ফাইলগুলো মেইন ফোল্ডারে খুঁজবে

const indexRouter = require("./index"); 
app.use("/", indexRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
