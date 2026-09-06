// views/profile/wheel.ejs-এর ক্লায়েন্ট কোড।
// docs/CSP.md ধাপ ৩: সার্ভার-সাইড মান JSON ডেটা ব্লক থেকে আসে।
// হুইলে শুধু ঘরের সংখ্যা আসে — কোনো পুরস্কারের মান ক্লায়েন্টে পাঠানো হয় না।

(function(){
  var cfg = {};
  var el = document.getElementById('profile-wheelConfig');
  if (el) { try { cfg = JSON.parse(el.textContent) || {}; } catch (e) { cfg = {}; } }

  const segments = new Array(cfg.segmentCount || 12).fill(null);
  const colors = ['#fff6e0', '#ffe9b8'];
  const canvas = document.getElementById('wheelCanvas');
  const ctx = canvas.getContext('2d');
  const cx = 136, cy = 136, radius = 136;
  const n = segments.length;
  const arc = (2 * Math.PI) / n;
  let currentRotation = 0;

  // আলোর বাতি (bulb) রিং তৈরি
  (function renderBulbs(){
    const holder = document.getElementById('wheelBulbs');
    if (!holder) return;
    const count = 24;
    const r = 148;
    for (let i = 0; i < count; i++) {
      const ang = (2 * Math.PI * i) / count;
      const x = 150 + r * Math.cos(ang) - 4;
      const y = 150 + r * Math.sin(ang) - 4;
      const b = document.createElement('div');
      b.className = 'fa-bulb';
      b.style.left = x + 'px';
      b.style.top = y + 'px';
      holder.appendChild(b);
    }
  })();

  function drawWheel() {
    ctx.clearRect(0, 0, 272, 272);
    for (let i = 0; i < n; i++) {
      const start = currentRotation + i * arc;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, start, start + arc);
      ctx.closePath();
      ctx.fillStyle = colors[i % colors.length];
      ctx.fill();
      ctx.strokeStyle = 'rgba(180,120,20,0.4)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // লেখা
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(start + arc / 2);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#7a3e00';
      ctx.font = 'bold 14px sans-serif';
      // স্পিনের আগে কোনো পুরস্কার দেখানো হয় না — প্রতিটা ঘরে একই নিরপেক্ষ চিহ্ন।
      ctx.fillText('?', radius - 22, 5);
      ctx.restore();
    }
  }
  drawWheel();

  // স্পিনের ফলাফল সার্ভার থেকে এনে দেখানো। ফ্রন্টএন্ড নিজে কোনো পুরস্কার হিসাব করে না —
  // spin() ইতিমধ্যে যা wheel_spins-এ লিখেছে, সেটাই পড়া হয়।
  async function revealResult() {
    const el = document.getElementById('result');
    try {
      const res = await fetch('/profile/wheel/result', { headers: { 'Accept': 'application/json' } });
      const data = await res.json();
      if (!data.success) {
        el.style.color = '#94a3b8';
        el.innerText = data.message || 'ফলাফল আনা যায়নি।';
        return;
      }
      el.style.color = '#10b981';
      el.innerText = '🎉 ' + data.message;
      if (data.prize > 0 && window.confetti) {
        confetti({ particleCount: 150, spread: 90, origin: { y: 0.6 } });
      }
      setTimeout(() => location.reload(), 2500);
    } catch (err) {
      el.style.color = '#94a3b8';
      el.innerText = 'ফলাফল আনা যায়নি। পেজ রিফ্রেশ করুন।';
    }
  }

  const spinBtn = document.getElementById('spinBtn');
  if (spinBtn) {
    spinBtn.addEventListener('click', async () => {
      if (spinBtn.disabled) return;
      spinBtn.disabled = true;
      document.getElementById('result').innerText = '';

      try {
        const res = await fetch('/profile/wheel/spin', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Origin': window.location.origin
          }
        });
        const data = await res.json();

        if (!data.success) {
          document.getElementById('result').style.color = '#ef4444';
          document.getElementById('result').innerText = data.message;
          spinBtn.disabled = false;
          return;
        }

        // যে ঘরে থামবে সেই index-এ পয়েন্টার (উপরে) আনতে ঘোরানো
        const targetIndex = data.index;
        const spins = 5; // কয়বার পুরো ঘুরবে
        // পয়েন্টার উপরে (−90°), তাই ওই ঘর উপরে আনতে হিসাব
        const targetAngle = (2 * Math.PI * spins) + (1.5 * Math.PI - (targetIndex * arc) - arc / 2);

        const duration = 4000;
        const startTime = performance.now();
        const startRotation = currentRotation;

        function animate(now) {
          const elapsed = now - startTime;
          const t = Math.min(elapsed / duration, 1);
          const ease = 1 - Math.pow(1 - t, 3); // ease-out
          currentRotation = startRotation + targetAngle * ease;
          drawWheel();
          if (t < 1) {
            requestAnimationFrame(animate);
          } else {
            // অ্যানিমেশন শেষ — এখন সার্ভার-নিশ্চিত ফলাফল আনা হয়। স্পিন রেসপন্সে পুরস্কার
            // বা জয়ের বার্তা আসে না, তাই হুইল থামার আগে ফলাফল জানার উপায় নেই।
            revealResult();
          }
        }
        requestAnimationFrame(animate);

      } catch (err) {
        document.getElementById('result').style.color = '#ef4444';
        document.getElementById('result').innerText = 'সমস্যা হয়েছে, আবার চেষ্টা করুন।';
        spinBtn.disabled = false;
      }
    });
  }
})();
