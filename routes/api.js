const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { apiUsageLogger } = require('../middleware/apiLogger');

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});

router.use(apiLimiter);
router.use(apiUsageLogger);

// TODO: Add key auth middleware, versioning, etc.

module.exports = router;
