const fs = require('fs');
const path = require('path');
const rbac = require('../../services/rbac');

// ==================== Phase 21: Admin → Super Admin ====================
//
// roadmap Phase 21 প্রতিটা unauthorized transition আটকানোর দাবি করে, যার
// একটা হলো "Admin → Super Admin"।
//
// পাওয়া ফাঁক: roles_manage permission থাকা একজন অ্যাডমিন /admin/roles/:id
// দিয়ে যেকোনো role-এ *সব* permission true করে দিতে পারত — নিজের role সহ।
// অর্থাৎ একটা Finance বা Support অ্যাডমিন নিজেকে কার্যত super admin
// বানিয়ে ফেলতে পারত। isSuperAdmin ফ্ল্যাগ না পেলেও সব permission পাওয়া
// কার্যত সমতুল্য: আর্থিক অনুমোদন, ব্যবহারকারী ব্যবস্থাপনা, KYC — সব।
//
// একই পথ role তৈরিতেও ছিল: সম্পাদনা বন্ধ করলেও কেউ একটা সর্ব-permission
// role বানিয়ে নিজেকে assign করে নিতে পারত।
//
// নিয়ম এখন: super_admin ছাড়া কেউ এমন permission দিতে পারবে না যা তার
// নিজের নেই — একজন কেবল নিজের ক্ষমতার উপসেট বিতরণ করতে পারে।

const ADMIN_SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'routes', 'admin.js'), 'utf8'
);

describe('Phase 21 — permissionsBeyondCaller যুক্তি', () => {
  test('caller-এর নেই এমন permission শনাক্ত করে', () => {
    const caller = { users_view: true, roles_manage: true };
    const requested = { users_view: true, roles_manage: true, payments_approve: true };
    expect(rbac.permissionsBeyondCaller(caller, requested)).toEqual(['payments_approve']);
  });

  test('উপসেট দিলে কিছু ফেরত দেয় না', () => {
    const caller = { users_view: true, roles_manage: true, payments_approve: true };
    const requested = { users_view: true, payments_approve: false };
    expect(rbac.permissionsBeyondCaller(caller, requested)).toEqual([]);
  });

  test('false দেওয়া permission escalation নয়', () => {
    // permission কেড়ে নেওয়া escalation নয়, তাই সেটা আটকানো উচিত নয়।
    const caller = { users_view: true };
    const requested = { users_view: true, payments_approve: false };
    expect(rbac.permissionsBeyondCaller(caller, requested)).toEqual([]);
  });

  test('caller-এর permission অনুপস্থিত থাকলেও নিরাপদে চলে', () => {
    expect(rbac.permissionsBeyondCaller({}, { anything: true })).toEqual(['anything']);
    expect(rbac.permissionsBeyondCaller({}, {})).toEqual([]);
  });
});

describe('Phase 21 — role রুটে গার্ড বসানো', () => {
  test('role সম্পাদনা ও তৈরি দুটোতেই গার্ড আছে', () => {
    // একটা বন্ধ করে অন্যটা খোলা রাখলে ফাঁকটা রয়েই যেত।
    const guards = ADMIN_SRC.match(/rbac\.permissionsBeyondCaller\(/g) || [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });

  test('super_admin ছাড় পায়', () => {
    expect(ADMIN_SRC).toMatch(/if \(!caller\.isSuperAdmin\)/);
    expect(ADMIN_SRC).toMatch(/if \(!creator\.isSuperAdmin\)/);
  });

  test('গার্ড updateRole/createRole ডাকার আগেই চলে', () => {
    // চেকটা পরে হলে পরিবর্তন ইতিমধ্যেই সেভ হয়ে যেত।
    const guardIdx = ADMIN_SRC.indexOf('rbac.permissionsBeyondCaller(');
    const updateIdx = ADMIN_SRC.indexOf('rbac.updateRole(');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(updateIdx);
  });

  test('চেষ্টাটা audit log-এ যায়', () => {
    // ব্লক করা যথেষ্ট নয় — কে চেষ্টা করেছে সেটা জানা দরকার।
    expect(ADMIN_SRC).toMatch(/PERMISSION_ESCALATION_BLOCKED/);
  });

  test('বার্তাটা দুই ভাষাতেই আছে', () => {
    const bn = require('../../locales/bn.json');
    const en = require('../../locales/en.json');
    expect(bn.admin_permission_escalation_blocked).toBeTruthy();
    expect(en.admin_permission_escalation_blocked).toBeTruthy();
  });
});

describe('Phase 21 — super_admin assignment আগের মতোই সুরক্ষিত', () => {
  test('super_admin বা NULL role শুধু super_admin দিতে পারে', () => {
    // এই গার্ডটা আগে থেকেই ছিল; নতুন কাজে যেন ভেঙে না যায়।
    expect(ADMIN_SRC).toMatch(/requestedRoleKey === null \|\| requestedRoleKey === 'super_admin'/);
  });
});
