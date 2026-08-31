const express = require('express');
const router = express.Router();
const { requireFeature } = require('../middleware/featureGate');

// পুরো রাউটারে ফিচার গেট — নির্দিষ্ট রুট নয়, রাউটার-লেভেলে বসানো হয়েছে
// যাতে ভবিষ্যতে যোগ হওয়া সাব-রুটও আপনাআপনি সুরক্ষিত থাকে, আর সরাসরি
// URL দিয়ে কোনো পথ বাদ পড়ে না যায়।
router.use(requireFeature('accumulator'));

const { isAuth } = require('../middleware/auth');
const { placeAccumulator, getUserAccumulators, getOpenMarkets } = require('../services/accumulator');

// অ্যাকুমুলেটর পেজ — ওপেন মার্কেট + আমার বাজি
router.get('/', isAuth, async (req, res) => {
  try {
    const matches = await getOpenMarkets();
    const myAccas = await getUserAccumulators(req.session.user.id);
    res.render('accumulator', { user: req.session.user, matches, myAccas });
  } catch (err) {
    console.error('accumulator page error:', err.message);
    res.render('accumulator', { user: req.session.user, matches: [], myAccas: [] });
  }
});

// বাজি স্থাপন (JSON)
router.post('/place', isAuth, async (req, res) => {
  try {
    const { stake, selections } = req.body;
    let sel = selections;
    if (typeof sel === 'string') {
      try { sel = JSON.parse(sel); } catch (e) { sel = []; }
    }
    const result = await placeAccumulator(req.session.user.id, stake, sel, req.lang);
    res.json(result);
  } catch (err) {
    console.error('accumulator place error:', err.message);
    res.json({ success: false, message: req.t('common_server_error') });
  }
});

module.exports = router;
