// tests/regression/literalNewlineInViews.test.js
// ---------------------------------------------------------------------------
// অডিট D10: admin ভিউতে `</script>\n<script ...>` — `\n` লেখাটা আক্ষরিক টেক্সট হিসেবে
// পেজে ছাপা হতো। এই টেস্ট নিশ্চিত করে যে এমন কোনো আক্ষরিক `\n` ফিরে না আসে।
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const viewsDir = path.join(__dirname, '..', '..', 'views', 'admin');

describe('admin ভিউতে আক্ষরিক \\n টেক্সট নেই (D10)', () => {
  const files = fs.readdirSync(viewsDir).filter((f) => f.endsWith('.ejs'));

  test.each(files)('%s', (file) => {
    const src = fs.readFileSync(path.join(viewsDir, file), 'utf8');
    expect(src).not.toMatch(/<\/script>\\n<script/);
  });
});
