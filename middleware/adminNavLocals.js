// middleware/adminNavLocals.js
// ---------------------------------------------------------------------------
// res.locals.adminNav সেট করে — views/admin/partials/admin-layout.ejs এটা
// ব্যবহার করে সাইডবার রেন্ডার করে।
//
// admin-layout শুধু /admin/* রুটেই ব্যবহৃত হয় না — /payment/admin/* (পেমেন্ট
// অ্যাপ্রুভাল, ডিপোজিট রিপোর্ট, ডেইলি সামারি) আর /chat/admin ও একই লেআউট
// রেন্ডার করে। তাই নেভ-বিল্ডিং একটা শেয়ার্ড মিডলওয়্যারে রাখা হয়েছে; নাহলে
// ওই পেজগুলোতে সাইডবার খালি আসত।
//
// fail-safe: ব্যর্থ হলে পূর্ণ নেভ দেখানো হয়। লিংক দেখানো নিজে কোনো অনুমতি
// দেয় না — প্রতিটা রুটের requirePermission() মিডলওয়্যারই আসল সিদ্ধান্ত নেয়।
// ---------------------------------------------------------------------------

const adminNav = require('../utils/adminNav');
const rbac = require('../services/rbac');

async function adminNavLocals(req, res, next) {
  if (!req.session || !req.session.user) return next();
  try {
    const { isSuperAdmin, permissions } = await rbac.getUserPermissions(req.session.user.id);
    res.locals.adminNav = adminNav.navFor(isSuperAdmin, permissions);
    res.locals.adminIsSuperAdmin = isSuperAdmin;
  } catch (e) {
    console.error('adminNav build error (showing full nav):', e.message);
    res.locals.adminNav = adminNav.NAV;
    res.locals.adminIsSuperAdmin = false;
  }
  next();
}

module.exports = { adminNavLocals };
