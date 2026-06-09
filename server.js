const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pool = require('./db');

const app = express();

// Security middlewares
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// Routes here...

app.get('/health', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));