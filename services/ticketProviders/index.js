// services/ticketProviders/index.js
// ---------------------------------------------------------------------------
// টিকেট প্রোভাইডার রেজিস্ট্রি। কাঠামো services/casinoProviders/index.js-এর
// সমান্তরাল।
//
// বর্তমানে কোনো বাস্তব অ্যাডাপ্টার নেই — ইচ্ছাকৃতভাবে। কাল্পনিক অ্যাডাপ্টার
// রেজিস্টার করলে অ্যাডমিন প্যানেলে একটা প্রোভাইডার "আছে" বলে দেখাত, অথচ
// কিছুই করত না। প্রোভাইডার না থাকা পর্যন্ত ইভেন্ট অ্যাডমিন হাতে তৈরি করেন।
//
// কনফিগারেশন: TICKET_PROVIDERS (ঐচ্ছিক allow-list)
// ---------------------------------------------------------------------------

const ADAPTERS = [];

function getEnabledProviders() {
  const allow = (process.env.TICKET_PROVIDERS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  return ADAPTERS.filter((adapter) => {
    if (allow.length && !allow.includes(adapter.name)) return false;
    try {
      return adapter.isEnabled();
    } catch (e) {
      console.error(`[ticketProvider:${adapter.name}] isEnabled error:`, e.message);
      return false;
    }
  });
}

module.exports = { ADAPTERS, getEnabledProviders };
