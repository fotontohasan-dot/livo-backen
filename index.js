const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.static("public"));

// Routes
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="bn">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Livo - Live Casino & Sports</title>
        <style>
            body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #0f172a; color: white; }
            h1 { color: #22c55e; }
            .stats { margin: 30px 0; font-size: 1.2rem; }
        </style>
    </head>
    <body>
        <h1>🌐 Livo - Live Casino & Sports</h1>
        <div class="stats">
            <p>👥 Active Users: 1248</p>
            <p>📺 Live Streams: 5</p>
            <p>🎰 Games: 42</p>
            <p>📖 Total Books: 150</p>
        </div>
        <p>স্বাগতম! আপনার ওয়েবসাইট এখন সঠিকভাবে চলছে।</p>
    </body>
    </html>
  `);
});

app.get("/livo-admin-panel", (req, res) => {
  res.send("<h2>Admin Panel - Coming Soon</h2>");
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
