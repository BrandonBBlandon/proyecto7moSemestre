const { Router } = require('express');

const telemetryController = require('../controllers/telemetry.controller');


const router = Router();

router.post('/readings', telemetryController.receiveReading);
router.get('/devices/:serialNumber/status', telemetryController.getDeviceStatus);
router.get('/devices/:serialNumber/readings', telemetryController.getDeviceReadings);
router.get('/devices/:serialNumber/incidents', telemetryController.getDeviceIncidents);
router.get('/devices/:serialNumber/report', telemetryController.getDailyReport);

module.exports = router;
