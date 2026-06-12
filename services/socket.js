const { Server } = require('socket.io');
const { pool } = require('../db');

function initSocket(server) {
  const io = new Server(server);

  io.on('connection', (socket) => {
    console.log('A user connected');

    socket.on('join', (userId) => {
      socket.join(`user_${userId}`);
      console.log(`User ${userId} joined their room`);
    });

    socket.on('join_admin', () => {
      socket.join('admin_room');
      console.log('Admin joined admin room');
    });

    socket.on('send_message', async (data) => {
      const { senderId, receiverId, message, isAdmin } = data;

      try {
        await pool.query(
          'INSERT INTO chat_messages (sender_id, receiver_id, message, is_admin) VALUES ($1, $2, $3, $4)',
          [senderId, receiverId, message, isAdmin]
        );

        if (isAdmin) {
          // Admin sending to a specific user
          io.to(`user_${receiverId}`).emit('new_message', {
            senderId,
            message,
            isAdmin: true,
            createdAt: new Date()
          });
        } else {
          // User sending to admin
          io.to('admin_room').emit('new_message', {
            senderId,
            message,
            isAdmin: false,
            createdAt: new Date()
          });
        }
      } catch (err) {
        console.error('Error saving message:', err);
      }
    });

    socket.on('disconnect', () => {
      console.log('User disconnected');
    });
  });

  return io;
}

module.exports = { initSocket };
