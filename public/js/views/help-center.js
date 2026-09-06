// views/help-center.ejs-এর ক্লায়েন্ট কোড।
// আগে টেমপ্লেটের ভেতরে ইনলাইন ব্লক ছিল; docs/CSP.md ধাপ ৩ অনুযায়ী বাইরে
// আনা হয়েছে যাতে CSP-র script-src থেকে unsafe-inline সরানো যায়।
// এই ব্লকে কোনো সার্ভার-সাইড মান ছিল না, তাই ফাইলটা স্ট্যাটিক।

const messagesBox = document.getElementById('chat-messages');
        const input = document.getElementById('chat-input');
        const sendBtn = document.getElementById('send-button');
        const typingEl = document.getElementById('bot-typing');
        const warningEl = document.getElementById('cf-warning');

        document.getElementById('init-time').textContent =
            new Date().toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' });

        function appendMessage(text, isUser) {
            const div = document.createElement('div');
            div.className = 'message ' + (isUser ? 'user-message' : 'bot-message');
            const textNode = document.createElement('div');
            textNode.textContent = text;
            div.appendChild(textNode);
            const time = document.createElement('div');
            time.className = 'message-time';
            time.textContent = new Date().toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' });
            div.appendChild(time);
            messagesBox.appendChild(div);
            messagesBox.scrollTop = messagesBox.scrollHeight;
        }

        async function sendToBot(text) {
            typingEl.style.display = 'block';
            messagesBox.scrollTop = messagesBox.scrollHeight;
            try {
                const res = await fetch('/help-center/api/chat', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: text })
                });
                const data = await res.json();
                typingEl.style.display = 'none';
                if (data.success) {
                    appendMessage(data.reply, false);
                } else {
                    appendMessage(data.error || 'দুঃখিত, একটা সমস্যা হয়েছে।', false);
                }
            } catch (e) {
                typingEl.style.display = 'none';
                appendMessage('দুঃখিত, সার্ভারে সংযোগ করা যায়নি। একটু পর আবার চেষ্টা করুন।', false);
            }
        }

        function handleSend() {
            const text = input.value.trim();
            if (!text) return;

            // ==== রিয়েল-টাইম ফ্রন্টএন্ড ফিল্টার — পাঠানোর আগে শেষবার চেক ====
            if (window.contentFilterIsBad(text)) {
                warningEl.style.display = 'block';
                return;
            }

            appendMessage(text, true);
            input.value = '';
            sendToBot(text);
        }

        sendBtn.addEventListener('click', handleSend);
        input.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleSend(); });

        // টাইপ করার সময় লাল বর্ডার + ওয়ার্নিং + সেন্ড বাটন ডিসেবল
        attachContentFilter('#chat-input', { submitButton: sendBtn, warningEl });

        // ক্যাটাগরি লিস্ট / কুইক-রিপ্লাই বাটনে ক্লিক করলে সরাসরি সেই মেসেজ পাঠানো
        document.querySelectorAll('.category-list li, .quick-reply').forEach((el) => {
            el.addEventListener('click', () => {
                const msg = el.getAttribute('data-msg');
                if (!msg) return;
                appendMessage(msg, true);
                sendToBot(msg);
            });
        });
