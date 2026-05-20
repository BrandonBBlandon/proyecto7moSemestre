require('dotenv').config();

const express = require('express');
const cors = require('cors');
const pool = require('./db');

const app = express();
const port = Number(process.env.PORT || 3000);
const corsOrigin = process.env.CORS_ORIGIN;
const defaultOrigins = ['http://localhost:5173', 'http://localhost:3000'];
const allowedOrigins = corsOrigin ? [corsOrigin] : defaultOrigins;

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('CORS origin not allowed'));
  }
}));

app.use(express.json());

app.post('/api/readings', async (req, res) => {
  try {
    const { deviceId = null, sensorValue, status = null } = req.body;
    const value = Number(sensorValue);

    if (
      sensorValue === undefined ||
      sensorValue === null ||
      sensorValue === '' ||
      typeof sensorValue === 'boolean' ||
      typeof sensorValue === 'object' ||
      !Number.isFinite(value)
    ) {
      return res.status(400).json({
        ok: false,
        message: 'sensorValue is required'
      });
    }

    await pool.execute(
      'INSERT INTO sensor_readings (device_id, sensor_value, status) VALUES (?, ?, ?)',
      [deviceId, value, status]
    );

    res.json({
      ok: true,
      message: 'Reading saved'
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      message: 'Internal server error'
    });
  }
});

app.get('/api/readings', async (req, res) => {
  try {
    const parsedLimit = Number(req.query.limit || 50);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 50;

    const [rows] = await pool.execute(
      'SELECT id, device_id AS deviceId, sensor_value AS sensorValue, status, created_at AS createdAt FROM sensor_readings ORDER BY created_at DESC, id DESC LIMIT ?',
      [limit]
    );

    res.json({
      ok: true,
      data: rows
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      ok: false,
      message: 'Internal server error'
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: 'Route not found'
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({
    ok: false,
    message: 'Internal server error'
  });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
