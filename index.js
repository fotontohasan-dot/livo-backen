const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static files (যদি পরে CSS/JS যোগ করো)
app.use(express.static('public'));

// Routes
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="bn">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Livo - Live Casino & Sports</title>
        <style>
            body {
                font-family: 'Segoe UI', Arial, sans-serif;
                text-align: center;
                padding: 60px 20px;
                background: linear-gradient(135deg, #0f172a, #1e2937);
                color: white;
                margin: 0;
            }
            h1 { color: #22c55e; font-size: 2.5rem; }
            .info { margin: 30px 0; font-size: 1.3rem; }
            .success { color: #4ade80; }
        </style>
    </head>
    <body>
        <h1>🌐 Livo - Live Casino & Sports</h1>
        <div class="info">
            <p class="success">✅ ওয়েবসাইট সফলভাবে চলছে!</p>
            <p>👥 Users: 1248 | 📺 Live: 5 | 🎮 Games: 42</p>
        </div>
        <p>স্বাগতম! আপনার সাইট এখন সঠিকভাবে লাইভ।</p>
    </body>
    </html>
  `);
});

app.get('/livo-admin-panel', (req, res) => {
  res.send('<h2>🔐 Admin Panel - Under Development</h2>');
});

// 404 Handler
app.use((req, res) => {
  res.status(404).send('<h2>404 - Page Not Found</h2>');
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
