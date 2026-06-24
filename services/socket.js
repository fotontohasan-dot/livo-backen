// services/socket.js
const { Server } = require('socket.io');
const { pool } = require('../db');
const sportsAPI = require('./sportsAPI');
const { syncMatches, getMatchesFromDB } = require('./matchUpdater');

let ioInstance = null;

function initSocket(server) {
  const io = new Server(server);
  ioInstance = io;

  io.on('connection', (socket) => {
    // ========== EXISTING: User & Admin chat rooms ==========
    socket.on('join', (userId) => {
      socket.join(`user_${userId}`);
    });

    socket.on('join_admin', () => {
      socket.join('admin_room');
    });

    socket.on('send_message', async (data) => {
      const { senderId, receiverId, message, isAdmin, fileUrl, fileType } = data;
      try {
        await pool.query(
          'INSERT INTO chat_messages (sender_id, receiver_id, message, is_admin, file_url, file_type) VALUES ($1, $2, $3, $4, $5, $6)',
          [senderId, receiverId || null, message || '', isAdmin, fileUrl || null, fileType || null]
        );
        if (isAdmin) {
          io.to(`user_${receiverId}`).emit('new_message', {
            senderId, message, isAdmin: true, fileUrl, fileType, createdAt: new Date()
          });
        } else {
          io.to('admin_room').emit('new_message', {
            senderId, message, isAdmin: false, fileUrl, fileType, createdAt: new Date()
          });
        }
      } catch (err) {
        console.error('Error saving message:', err);
      }
    });

    // ========== NEW: Live Matches room ==========
    socket.on('join_matches', () => {
      socket.join('matches_room');
      // Send current matches immediately on join
      sendMatchesUpdate(socket);
    });

    socket.on('leave_matches', () => {
      socket.leave('matches_room');
    });

    socket.on('disconnect', () => {});
  });

  // ========== BACKGROUND: Live match polling ==========
  // Every 60 seconds: fetch fresh data, update DB, broadcast to room
  startLiveMatchBroadcasting(io);

  return io;
}

// Send current matches snapshot to one socket (on join)
async function sendMatchesUpdate(socket) {
  try {
    const matches = await getMatchesFromDB('all');
    socket.emit('matches_update', {
      timestamp: Date.now(),
      matches,
    });
  } catch (err) {
    // silent fail
  }
}

// Broadcast to everyone in matches_room
async function broadcastMatches(io) {
  try {
    const matches = await getMatchesFromDB('all');
    io.to('matches_room').emit('matches_update', {
      timestamp: Date.now(),
      matches,
    });
  } catch (err) {
    console.error('broadcastMatches error:', err.message);
  }
}

// Periodic refresh: every 60s pull fresh from API, save to DB, broadcast
function startLiveMatchBroadcasting(io) {
  const REFRESH_INTERVAL = 60 * 1000; // 60 seconds

  setInterval(async () => {
    // Only refresh if at least one user is listening (saves API quota)
    const room = io.sockets.adapter.rooms.get('matches_room');
    if (!room || room.size === 0) return;

    try {
      await syncMatches();        // pull fresh from API, upsert in DB
      await broadcastMatches(io); // push to all clients
    } catch (err) {
      console.error('Live broadcast error:', err.message);
    }
  }, REFRESH_INTERVAL);

  console.log('🟢 Live match broadcasting started (60s interval)');
}

// Expose io for use elsewhere (e.g., notifications)
function getIO() {
  return ioInstance;
}

module.exports = { initSocket, getIO, broadcastMatches };
