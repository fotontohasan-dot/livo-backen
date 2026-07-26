// services/queue/index.js — single import point
module.exports = {
  ...require('./queues'),
  ...require('./monitor'),
  startWorkers: require('./workers').startWorkers,
  stopWorkers:  require('./workers').stopWorkers,
  isAvailable:  require('./connection').isAvailable,
};
