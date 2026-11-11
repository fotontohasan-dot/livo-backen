// public/js/socket-client.js
// Socket.IO ক্লায়েন্টের একমাত্র এন্ট্রি পয়েন্ট। /socket.io/socket.io.js-এর *পরে* লোড করতে হয়।
//
// কেন WebSocket-only: একাধিক web ইনস্ট্যান্সের পেছনে HTTP long-polling-এ একটা সেশনের একাধিক রিকোয়েস্ট
// ভিন্ন ইনস্ট্যান্সে গেলে "Session ID unknown" হয় (sticky session ছাড়া)। WebSocket একটাই দীর্ঘস্থায়ী
// কানেকশন, তাই একই ইনস্ট্যান্সে থাকে। সার্ভারও transports: ['websocket']-এ সীমিত (services/socket.js) —
// দুই দিকের তালিকা একই রাখতে হবে।
//
// ব্যবহার: `var socket = window.livoSocket();` — সরাসরি io() ডাকা যাবে না।
// socket.io v4 একই origin/path-এ কানেকশন multiplex করে, তাই একাধিকবার ডাকলে একই কানেকশন ফেরে।
(function (global) {
  'use strict';
  var OPTIONS = {
    transports: ['websocket'],
    // ডিপ্লয়/রিস্টার্টের সময় সার্ভার ফিরে আসা পর্যন্ত চেষ্টা চলতে থাকে; একসাথে সব ক্লায়েন্ট ঝাঁপিয়ে না পড়তে jitter
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    randomizationFactor: 0.5
  };

  global.livoSocket = function livoSocket() {
    if (typeof global.io !== 'function') return null; // socket.io ক্লায়েন্ট লোড হয়নি
    return global.io(OPTIONS);
  };
  global.livoSocket.OPTIONS = OPTIONS;
})(window);
