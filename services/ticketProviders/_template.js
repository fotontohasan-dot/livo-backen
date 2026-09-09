// services/ticketProviders/_template.js
// ---------------------------------------------------------------------------
// ইভেন্ট-টিকেট প্রোভাইডার অ্যাডাপ্টারের টেমপ্লেট।
//
// কাঠামোটা ইচ্ছাকৃতভাবে services/casinoProviders/_template.js-এর সমান্তরাল —
// একই ধারণা দুই জায়গায় দুইরকম দেখালে রক্ষণাবেক্ষণে ভুল হয়।
//
// প্রোভাইডার না থাকলেও মডিউলটা সম্পূর্ণ কার্যকর: অ্যাডমিন
// /admin/tickets থেকে হাতে ইভেন্ট ও ক্যাটাগরি তৈরি করতে পারেন। অ্যাডাপ্টার
// যোগ হলে সেটা একই ticket_events / ticket_categories টেবিলেই লিখবে
// (UNIQUE (provider, provider_event_id)-এর উপর UPSERT)।
//
// ⚠️ কোনো credential হার্ডকোড নয় — সব process.env থেকে।
// ---------------------------------------------------------------------------

const { fetchWithTimeout } = require('../../utils/httpClient');
const NAME = 'template-ticket-provider';

function env(suffix) {
  return process.env[`TICKET_PROVIDER_${NAME.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${suffix}`] || '';
}

module.exports = {
  name: NAME,

  isEnabled() {
    return !!(env('API_URL') && env('API_KEY'));
  },

  /**
   * প্রোভাইডারের ইভেন্ট তালিকা → normalized আকার:
   * { providerEventId, title, competition, homeTeam, awayTeam, venue, city,
   *   country, eventDate (ISO), bannerUrl,
   *   categories: [{ name, price, currency, totalQty, maxPerUser }] }
   */
  async fetchEvents() {
    const res = await fetchWithTimeout(`${env('API_URL')}/events`, {
      headers: { 'X-Api-Key': env('API_KEY') }
    });
    if (!res.ok) throw new Error(`${NAME} fetchEvents HTTP ${res.status}`);
    const data = await res.json();
    return (data.events || []).map(e => ({
      providerEventId: e.id,
      title: e.name,
      competition: e.competition,
      homeTeam: e.home, awayTeam: e.away,
      venue: e.venue, city: e.city, country: e.country,
      eventDate: e.starts_at,
      bannerUrl: e.image,
      categories: (e.tiers || []).map(t => ({
        name: t.name, price: t.price, currency: t.currency || 'BDT',
        totalQty: t.available, maxPerUser: t.max_per_order || 4
      }))
    }));
  }
};
