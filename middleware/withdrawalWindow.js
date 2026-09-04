// middleware/withdrawalWindow.js
// ---------------------------------------------------------------------------
// উইথড্র সময়সূচির গেট। requireFeature('withdrawal')-এর *পরে* বসে, অর্থাৎ
// ফিচার ফ্ল্যাগ বন্ধ থাকলে সেটাই আগে থামায় — এই স্তর তার বিকল্প নয়।
//
// GET (পেজ দেখা) আটকানো হয় না: ইউজার পেজে ঢুকে জানতে পারবেন কখন আবার
// খুলবে, তবে ফর্মটা নিষ্ক্রিয় থাকবে। আসল সুরক্ষা POST-এ — সার্ভারেই যাচাই
// হয়, ফর্ম লুকানো ভরসা করা হয় না।
// ---------------------------------------------------------------------------

const withdrawalWindow = require('../services/withdrawalWindow');

function wantsJson(req) {
  return req.xhr ||
    (req.get('accept') || '').includes('application/json') ||
    req.originalUrl.startsWith('/api/');
}

function messageFor(req, state) {
  const t = (req.t ? req.t : (k) => k);
  if (state.reason === 'forced_closed') return t('withdraw_window_closed_manual');
  // "রাত ২৩:০০ থেকে ০৭:০০ পর্যন্ত বন্ধ" — সময়টা বলে দিলে ইউজার অকারণে
  // সাপোর্টে লিখবেন না।
  const tpl = t('withdraw_window_closed_scheduled');
  return String(tpl).replace('{start}', state.start).replace('{end}', state.end);
}

/** POST গার্ড — বন্ধ সময়ে নতুন উইথড্র রিকোয়েস্ট গ্রহণ করা হয় না। */
function requireWithdrawalWindow() {
  return async function withdrawalWindowGate(req, res, next) {
    let state;
    try {
      state = await withdrawalWindow.getState();
    } catch (err) {
      // fail-open — service-এর মতোই যুক্তি (services/withdrawalWindow.js দেখুন)
      console.error('withdrawalWindow gate error:', err.message);
      return next();
    }

    if (state.open) return next();

    const message = messageFor(req, state);

    if (wantsJson(req)) {
      return res.status(403).json({ ok: false, success: false, error: message, message });
    }
    if (req.flash) {
      req.flash('error', message);
      return res.redirect('/payment/withdraw');
    }
    return res.status(403).render('error', {
      user: (req.session && req.session.user) || null,
      message
    });
  };
}

/**
 * GET-এর জন্য — ব্লক করে না, শুধু ভিউতে অবস্থাটা পৌঁছে দেয় যাতে পেজে
 * নোটিশ দেখানো ও ফর্ম নিষ্ক্রিয় করা যায়।
 */
function attachWithdrawalWindow() {
  return async function attach(req, res, next) {
    try {
      res.locals.withdrawalWindow = await withdrawalWindow.getState();
    } catch (err) {
      console.error('withdrawalWindow attach error:', err.message);
      res.locals.withdrawalWindow = { open: true, reason: 'config_unavailable' };
    }
    next();
  };
}

module.exports = { requireWithdrawalWindow, attachWithdrawalWindow, messageFor };
