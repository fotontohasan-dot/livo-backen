// ক্লায়েন্ট-সাইড holder_name নিয়ম — সার্ভারের utils/holderName.js-এর হুবহু সমান। আসল গার্ড সার্ভার; এটা শুধু ব্যবহারকারীকে আগেই জানায়।
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HolderNameValidate = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var MIN_LEN = 2, MAX_LEN = 60;
  var RE = /^[\p{L}\p{M}][\p{L}\p{M}\u200c\u200d .'’-]*$/u;
  function check(input) {
    if (typeof input !== 'string') return { valid: false, value: null };
    var v;
    try { v = input.normalize('NFC').trim().replace(/ {2,}/g, ' '); } catch (e) { return { valid: false, value: null }; }
    var chars = Array.from(v);
    if (chars.length < MIN_LEN || chars.length > MAX_LEN) return { valid: false, value: null };
    if (!RE.test(v)) return { valid: false, value: null };
    var letters = chars.filter(function (ch) { return /\p{L}/u.test(ch); }).length;
    if (letters < MIN_LEN) return { valid: false, value: null };
    return { valid: true, value: v };
  }
  function attach(doc) {
    var inputs = doc.querySelectorAll('input[name="holder_name"]');
    Array.prototype.forEach.call(inputs, function (input) {
      var msg = input.getAttribute('data-invalid-msg') || '';
      function run() { input.setCustomValidity(input.value && !check(input.value).valid ? msg : ''); }
      input.addEventListener('input', run);
      input.addEventListener('blur', run);
      if (input.form) input.form.addEventListener('submit', function (e) {
        run();
        if (!check(input.value).valid) { e.preventDefault(); input.setCustomValidity(msg); input.reportValidity(); }
      });
    });
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { attach(document); });
    else attach(document);
  }
  return { check: check, MIN_LEN: MIN_LEN, MAX_LEN: MAX_LEN };
});
