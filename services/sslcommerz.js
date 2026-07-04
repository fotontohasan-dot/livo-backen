// services/sslcommerz.js
// SSLCommerz পেমেন্ট গেটওয়ে — সেশন তৈরি ও ট্রানজেকশন ভ্যালিডেশন
// native fetch ব্যবহার করা হয়েছে (Node 24+ এ বিল্ট-ইন), আলাদা প্যাকেজ লাগবে না

const STORE_ID = process.env.SSLCZ_STORE_ID;
const STORE_PASSWD = process.env.SSLCZ_STORE_PASSWD;
const IS_LIVE = process.env.SSLCZ_IS_LIVE === 'true';

const BASE_URL = IS_LIVE
  ? 'https://securepay.sslcommerz.com'
  : 'https://sandbox.sslcommerz.com';

// পেমেন্ট সেশন শুরু করে GatewayPageURL রিটার্ন করে
async function initPayment({ amount, tranId, customer, baseUrl }) {
  if (!STORE_ID || !STORE_PASSWD) {
    throw new Error('SSLCZ_STORE_ID / SSLCZ_STORE_PASSWD সেট করা নেই (.env)');
  }

  const params = new URLSearchParams({
    store_id: STORE_ID,
    store_passwd: STORE_PASSWD,
    total_amount: String(amount),
    currency: 'BDT',
    tran_id: tranId,
    success_url: `${baseUrl}/payment/sslcommerz/success`,
    fail_url: `${baseUrl}/payment/sslcommerz/fail`,
    cancel_url: `${baseUrl}/payment/sslcommerz/cancel`,
    ipn_url: `${baseUrl}/payment/sslcommerz/ipn`,
    shipping_method: 'NO',
    product_name: 'Livo Coins',
    product_category: 'Gaming',
    product_profile: 'general',
    cus_name: customer.name || 'Livo User',
    cus_email: customer.email || 'user@livo.app',
    cus_add1: 'Dhaka',
    cus_city: 'Dhaka',
    cus_postcode: '1000',
    cus_country: 'Bangladesh',
    cus_phone: customer.phone || '01700000000',
    num_of_item: '1'
  });

  const res = await fetch(`${BASE_URL}/gwprocess/v4/api.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  const data = await res.json();
  if (data.status !== 'SUCCESS') {
    throw new Error(data.failedreason || 'SSLCommerz সেশন শুরু করা যায়নি');
  }
  return data.GatewayPageURL;
}

// val_id দিয়ে ট্রানজেকশন যাচাই করে (সার্ভার-সাইড, স্পুফিং ঠেকাতে বাধ্যতামূলক)
async function validatePayment(valId) {
  if (!STORE_ID || !STORE_PASSWD) {
    throw new Error('SSLCZ_STORE_ID / SSLCZ_STORE_PASSWD সেট করা নেই (.env)');
  }
  const params = new URLSearchParams({
    val_id: valId,
    store_id: STORE_ID,
    store_passwd: STORE_PASSWD,
    format: 'json'
  });
  const res = await fetch(`${BASE_URL}/validator/api/validationserverAPI.php?${params.toString()}`);
  const data = await res.json();
  return data; // data.status === 'VALID' / 'VALIDATED' হলে সফল
}

module.exports = { initPayment, validatePayment };
