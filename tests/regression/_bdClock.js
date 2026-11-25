// টেস্ট-সাহায্যকারী: শুধু Date ঘড়ি স্থির (বাকি টাইমার আসল), আসল Postgres/HTTP।
const DATE_ONLY = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval',
  'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'];
async function at(isoUtc, fn) {
  jest.useFakeTimers({ now: new Date(isoUtc), doNotFake: DATE_ONLY });
  try { return await fn(); } finally { jest.useRealTimers(); }
}
module.exports = { at };
