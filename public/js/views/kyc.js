// views/kyc.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

let uploadedOk = false;

function setSubmitState(enabled, text) {
  const btn = document.getElementById('submitBtn');
  if (!btn) return;
  btn.disabled = !enabled;
  document.getElementById('submitBtnText').textContent = text;
}

async function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;

  const errBox = document.getElementById('uploadError');
  errBox.style.display = 'none';
  uploadedOk = false;
  setSubmitState(false, 'আপলোড হচ্ছে...');

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    errBox.textContent = 'শুধু JPG, PNG বা WEBP ছবি আপলোড করা যাবে।';
    errBox.style.display = 'block';
    LivoToast.show(errBox.textContent, 'error');
    setSubmitState(false, 'প্রথমে ছবি আপলোড করুন');
    return;
  }
  if (file.size > 20 * 1024 * 1024) {
    errBox.textContent = 'ফাইলের সাইজ ২০MB-এর বেশি হতে পারবে না।';
    errBox.style.display = 'block';
    LivoToast.show(errBox.textContent, 'error');
    setSubmitState(false, 'প্রথমে ছবি আপলোড করুন');
    return;
  }

  document.getElementById('uploadIcon').className = 'fas fa-spinner fa-spin';
  document.getElementById('uploadText').textContent = 'আপলোড হচ্ছে...';

  const reader = new FileReader();
  reader.onload = () => {
    const img = document.getElementById('previewImg');
    img.src = reader.result;
    img.style.display = 'block';
  };
  reader.readAsDataURL(file);

  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/chat/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok || !data.url) {
      throw new Error(data.error || 'আপলোড ব্যর্থ হয়েছে');
    }

    document.getElementById('documentUrl').value = data.url;
    document.getElementById('uploadIcon').className = 'fas fa-circle-check';
    document.getElementById('uploadIcon').style.color = '#10b981';
    document.getElementById('uploadText').textContent = 'ছবি আপলোড সম্পন্ন ✓';
    uploadedOk = true;
    LivoToast.show('ছবি আপলোড সম্পন্ন হয়েছে', 'success');
    setSubmitState(true, 'KYC জমা দিন');
  } catch (err) {
    errBox.textContent = err.message || 'আপলোড ব্যর্থ হয়েছে, আবার চেষ্টা করুন।';
    errBox.style.display = 'block';
    LivoToast.show(errBox.textContent, 'error');
    document.getElementById('uploadIcon').className = 'fas fa-cloud-arrow-up';
    document.getElementById('uploadIcon').style.color = 'var(--gold)';
    document.getElementById('uploadText').textContent = 'ছবি আপলোড করতে এখানে ট্যাপ করুন';
    setSubmitState(false, 'প্রথমে ছবি আপলোড করুন');
  }
}

function handleKycSubmit(e) {
  if (!uploadedOk || !document.getElementById('documentUrl').value) {
    e.preventDefault();
    const errBox = document.getElementById('uploadError');
    errBox.textContent = 'জমা দেওয়ার আগে ডকুমেন্টের ছবি আপলোড করুন।';
    errBox.style.display = 'block';
    LivoToast.show(errBox.textContent, 'error');
    return false;
  }
  setSubmitState(false, 'জমা হচ্ছে...');
  return true;
}

// KYC ফর্ম ও ফাইল নির্বাচন — আগে ইনলাইন হ্যান্ডলার ছিল।
// handleKycSubmit false ফেরালে সাবমিট থামত, তাই preventDefault() দিয়ে
// একই আচরণ (docs/CSP.md ধাপ ২)।
document.addEventListener('DOMContentLoaded', function () {
  document.querySelectorAll('[data-kyc-form]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (handleKycSubmit(e) === false) e.preventDefault();
    });
  });
  document.querySelectorAll('[data-kyc-file]').forEach(function (input) {
    input.addEventListener('change', handleFileSelect);
  });
});
