const { Server } = require('socket.io');
const { pool } = require('../db');

function initSocket(server) {
  const io = new Server(server);

  io.on('connection', (socket) => {

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

    socket.on('disconnect', () => {});
  });

  return io;
}

module.exports = { initSocket };
