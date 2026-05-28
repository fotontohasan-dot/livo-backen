const express = require("express");
const router = express.Router();
const index_controller = require("../controllers/indexController");

// হোম পেজের রুট
router.get("/", index_controller.index);

module.exports = router;
