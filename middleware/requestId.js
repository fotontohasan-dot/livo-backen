// middleware/requestId.js
// প্রতিটা ইনকামিং রিকোয়েস্টে একটা ইউনিক ID বসিয়ে দেয় (req.requestId) — Audit Log-এ প্রতিটা এন্ট্রি
// কোন রিকোয়েস্টের সাথে সম্পর্কিত সেটা ট্রেস করার জন্য, এবং X-Request-Id রেসপন্স হেডারেও পাঠানো হয়
// (ক্লায়েন্ট/সাপোর্ট টিকিটে রেফারেন্স করার জন্য কাজে লাগে)। আপস্ট্রিম প্রক্সি ইতিমধ্যে
// X-Request-Id পাঠালে সেটাই পুনঃব্যবহার করা হয়, নাহলে নতুন তৈরি হয়।

const crypto = require('crypto');

function requestId(req, res, next) {
  try {
    req.requestId = req.headers['x-request-id'] || crypto.randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
  } catch (err) {
    // ব্যর্থ হলেও রিকোয়েস্ট আটকাবে না — শুধু requestId undefined থাকবে
    console.error('[requestId] error (non-blocking):', err.message);
  }
  next();
}

module.exports = requestId;
