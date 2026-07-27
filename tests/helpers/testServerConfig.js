// tests/helpers/testServerConfig.js
const path = require('path');

module.exports = {
  PORT: process.env.TEST_SERVER_PORT || 4569,
  BASE_URL: `http://127.0.0.1:${process.env.TEST_SERVER_PORT || 4569}`,
  PID_FILE: path.join(__dirname, '..', '..', '.tmp-test-server.pid')
};
