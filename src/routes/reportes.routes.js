const express = require('express');
const reportesController = require('../controllers/reportes.controller');

const router = express.Router();

router.get('/', reportesController.index);
router.get('/daily', reportesController.daily);
router.get('/range', reportesController.range);
router.get('/monthly', reportesController.monthly);
router.get('/latest', reportesController.latest);
router.get('/recent', reportesController.latest);

module.exports = router;
