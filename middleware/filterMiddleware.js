/**
 * middleware/filterMiddleware.js
 * ---------------------------------------------------------------------------
 * req.body-এর সাধারণ টেক্সট ফিল্ডগুলো (message, text, content, comment,
 * description, feedback, note, title, reason ইত্যাদি) স্বয়ংক্রিয়ভাবে
 * utils/contentFilter.js দিয়ে চেক করে। খারাপ কনটেন্ট পেলে 400 স্ট্যাটাস +
 * সুন্দর বাংলা/ইংরেজি মেসেজ রিটার্ন করে, ভালো হলে next() কল করে এগিয়ে যায়।
 *
 * ব্যবহার (যেকোনো POST রুটে):
 *   const { filterMiddleware } = require('../middleware/filterMiddleware');
 *   router.post('/feedback', isAuth, filterMiddleware(), async (req, res) => { ... });
 *
 * কাস্টম ফিল্ড নাম দিতে চাইলে:
 *   filterMiddleware({ fields: ['title', 'body'] })
 * ---------------------------------------------------------------------------
 */

const { checkContent } = require('../utils/contentFilter');

// ডিফল্টভাবে যেসব ফিল্ড নাম চেক করা হবে — প্রজেক্টের সব ফর্মে এর কোনো না কোনোটাই আছে
const DEFAULT_FIELDS = [
  'message', 'text', 'content', 'comment', 'description',
  'feedback', 'note', 'notes', 'title', 'reason', 'bio', 'nickname',
];

/**
 * @param {object} options
 * @param {string[]} [options.fields] - req.body-তে কোন কোন কী (key) চেক করা হবে
 * @returns {import('express').RequestHandler}
 */
function filterMiddleware(options = {}) {
  const fields = options.fields || DEFAULT_FIELDS;

  return function (req, res, next) {
    if (!req.body || typeof req.body !== 'object') return next();

    for (const field of fields) {
      const value = req.body[field];
      if (typeof value !== 'string' || !value.trim()) continue;

      const result = checkContent(value);
      if (result.flagged) {
        return res.status(400).json({
          success: false,
          error: 'আপনার লেখায় অনুপযুক্ত/অশ্লীল কনটেন্ট শনাক্ত হয়েছে। অনুগ্রহ করে সংশোধন করে আবার চেষ্টা করুন।',
          errorEn: 'Inappropriate content detected. Please revise your message and try again.',
          field,
        });
      }
    }

    next();
  };
}

module.exports = { filterMiddleware, DEFAULT_FIELDS };
