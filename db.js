const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.DATABASE_URL, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log('✅ MongoDB connected successfully');

    // Chat Messages Schema
    const chatMessageSchema = new mongoose.Schema({
      sender_id: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true 
      },
      receiver_id: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User' 
      },
      message: { 
        type: String, 
        required: true 
      },
      is_admin: { 
        type: Boolean, 
        default: false 
      },
      created_at: { 
        type: Date, 
        default: Date.now 
      }
    });

    // Model তৈরি
    if (!mongoose.models.ChatMessage) {
      mongoose.model('ChatMessage', chatMessageSchema);
    }

    module.exports.ChatMessage = mongoose.model('ChatMessage');

  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    process.exit(1);
  }
};

module.exports = { connectDB };