  const msgEl = document.getElementById('msg');
  const linkEl = document.getElementById('link');

  const btnWhatsapp  = document.getElementById('btnWhatsapp');
  const btnMessenger = document.getElementById('btnMessenger');
  const btnFacebook  = document.getElementById('btnFacebook');
  const btnInstagram = document.getElementById('btnInstagram');
  const btnViber     = document.getElementById('btnViber');
  const btnImo       = document.getElementById('btnImo');
  const status       = document.getElementById('status');

  function updateLinks() {
    const text = msgEl.value.trim();
    const link = linkEl.value.trim();
    const combined = encodeURIComponent(text + ' ' + link);
    const encLink = encodeURIComponent(link);

    btnWhatsapp.href  = `https://wa.me/?text=${combined}`;
    btnFacebook.href  = `https://www.facebook.com/sharer/sharer.php?u=${encLink}`;
    btnMessenger.href = `fb-messenger://share/?link=${encLink}`;
    btnViber.href     = `viber://forward?text=${combined}`;
    btnImo.href       = `imo://send?text=${combined}`;

    btnInstagram.onclick = async (e) => {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(text + ' ' + link);
        status.textContent = 'টেক্সট কপি হয়েছে — এখন Instagram-এ পেস্ট করুন';
      } catch {
        status.textContent = 'কপি করা যায়নি, ম্যানুয়ালি কপি করুন';
      }
      window.location.href = 'instagram://app';
    };
  }

  msgEl.addEventListener('input', updateLinks);
  linkEl.addEventListener('input', updateLinks);
  updateLinks();
