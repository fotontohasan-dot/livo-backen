require('dotenv').config();
const process = require('node:process');
const express = require('express');
const http = require('http');
const { initSocket } = require('./services/socket');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const { connectDB } = require('./db');
const { syncMatches } = require('./services/matchUpdater');

const app = express();
const server = http.createServer(app);
initSocket(server);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'livo-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(flash());

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  next();
});

app.use('/', require('./routes/auth'));
app.use('/matches', require('./routes/matches'));
app.use('/tournaments', require('./routes/tournaments'));
app.use('/coins', require('./routes/coins'));
app.use('/news', require('./routes/news'));
app.use('/profile', require('./routes/profile'));
app.use('/leaderboard', require('./routes/leaderboard'));
app.use('/admin', require('./routes/admin'));
app.use('/notifications', require('./routes/notifications'));
app.use('/payment', require('./routes/payment'));
app.use('/games', require('./routes/games'));
app.use('/chat', require('./routes/chat'));

app.get('/app/update', (req, res) => res.render('app/update'));

const PORT = process.env.PORT || 3000;

connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    setInterval(async () => {
      try {
        await syncMatches();
      } catch (err) {
        console.error('Error in auto match sync:', err);
      }
    }, 24 * 60 * 60 * 1000);
    syncMatches().catch(err => console.error('Initial match sync failed:', err));
  });
}).catch(console.error);

module.exports = app;
