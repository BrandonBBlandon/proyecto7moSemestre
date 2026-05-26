require('dotenv').config();

const express = require('express');
const cors = require('cors');
const pool = require('./db');
const reportesRoutes = require('./routes/reportes.routes');

const app = express();
const port = Number(process.env.PORT || 3000);
const warningThreshold = Number(process.env.WARNING_THRESHOLD || 600);
const alarmThreshold = Number(process.env.ALARM_THRESHOLD || 800);
const defaultRecentLimit = getLimit(process.env.RECENT_LIMIT, 10, 200);
const defaultOrigins = ['http://localhost:5173', 'http://localhost:3000', 'http://localhost:8100', 'http://127.0.0.1:8100'];
const allowedOrigins = getAllowedOrigins(process.env.CORS_ORIGIN, defaultOrigins);
const allowAnyOrigin = allowedOrigins.includes('*');

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    return callback(null, false);
  }
}));

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'proyecto-7mo-semestre-backend',
    timestamp: new Date().toISOString()
  });
});

app.use('/api/reportes', reportesRoutes);
app.use('/api/reports', reportesRoutes);

app.get('/api/db/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');

    res.json({
      ok: true,
      message: 'Database connection is working'
    });
  } catch (error) {
    console.error(error);
    res.status(503).json({
      ok: false,
      message: 'Database connection failed',
      error: getPublicError(error)
    });
  }
});

app.post('/api/readings', async (req, res) => {
  try {
    const { deviceId = null, sensorValue } = req.body;
    const value = Number(sensorValue);
    const normalizedDeviceId = normalizeDeviceId(deviceId);

    if (!isValidSensorValue(sensorValue, value)) {
      return res.status(400).json({
        ok: false,
        message: 'sensorValue is required'
      });
    }

    if (normalizedDeviceId === undefined || normalizedDeviceId === null) {
      return res.status(400).json({
        ok: false,
        message: 'deviceId is required and must be a positive integer'
      });
    }

    const status = req.body.status ? String(req.body.status) : getStatus(value);

    if (!isValidStatus(status)) {
      return res.status(400).json({
        ok: false,
        message: 'status must be normal, warning, or alarm'
      });
    }

    const deviceExists = await existsDevice(normalizedDeviceId);

    if (!deviceExists) {
      return res.status(400).json({
        ok: false,
        message: 'deviceId does not exist'
      });
    }

    await pool.execute(
      'INSERT INTO sensor_readings (device_id, sensor_value, processed_value, risk_level, status) VALUES (?, ?, ?, ?, ?)',
      [normalizedDeviceId, value, value, status, status]
    );

    res.json({
      ok: true,
      message: 'Reading saved',
      data: {
        deviceId: normalizedDeviceId,
        sensorValue: value,
        status
      }
    });
  } catch (error) {
    console.error(error);
    sendError(res, error);
  }
});

app.get('/api/readings/latest', async (req, res) => {
  try {
    const limit = getLimit(req.query.limit, defaultRecentLimit, 200);
    const rows = await getRecentReadings(limit);

    res.json({
      ok: true,
      data: rows
    });
  } catch (error) {
    console.error(error);
    sendError(res, error);
  }
});

app.get('/api/readings', async (req, res) => {
  try {
    const limit = getLimit(req.query.limit, defaultRecentLimit, 200);
    const rows = await getRecentReadings(limit);

    res.json({
      ok: true,
      data: rows
    });
  } catch (error) {
    console.error(error);
    sendError(res, error);
  }
});

app.get('/api/monitoring/current', async (req, res) => {
  try {
    const rows = await getRecentReadings(1);
    const current = rows[0] || null;

    res.json({
      ok: true,
      data: {
        current,
        latestReading: current,
        sensorValue: current ? current.sensorValue : null,
        status: current ? current.status : 'unknown',
        deviceId: current ? current.deviceId : null,
        createdAt: current ? current.createdAt : null,
        thresholds: {
          warning: warningThreshold,
          alarm: alarmThreshold
        }
      }
    });
  } catch (error) {
    console.error(error);
    sendError(res, error);
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
  sendError(res, error);
});

function isValidSensorValue(input, value) {
  return !(
    input === undefined ||
    input === null ||
    input === '' ||
    typeof input === 'boolean' ||
    typeof input === 'object' ||
    !Number.isFinite(value)
  );
}

function normalizeDeviceId(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function isValidStatus(value) {
  return ['normal', 'warning', 'alarm'].includes(value);
}

async function existsDevice(deviceId) {
  const [rows] = await pool.execute(
    'SELECT id FROM devices WHERE id = ? LIMIT 1',
    [deviceId]
  );

  return rows.length > 0;
}

function getStatus(value) {
  if (value >= alarmThreshold) {
    return 'alarm';
  }

  if (value >= warningThreshold) {
    return 'warning';
  }

  return 'normal';
}

function getLimit(value, fallback, max) {
  const parsed = Number(value || fallback);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function sendError(res, error) {
  if (res.headersSent) {
    return;
  }

  res.status(getErrorStatus(error)).json({
    ok: false,
    message: 'Internal server error',
    error: getPublicError(error)
  });
}

function getErrorStatus(error) {
  const transientDatabaseCodes = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'ETIMEDOUT',
    'PROTOCOL_CONNECTION_LOST',
    'HANDSHAKE_SSL_ERROR'
  ]);

  if (transientDatabaseCodes.has(error && error.code)) {
    return 503;
  }

  return 500;
}

function getPublicError(error) {
  if (process.env.NODE_ENV === 'production') {
    return {
      code: error && error.code ? error.code : 'INTERNAL_ERROR'
    };
  }

  return {
    code: error && error.code ? error.code : 'INTERNAL_ERROR',
    message: error && error.message ? error.message : 'Unexpected error'
  };
}

function getAllowedOrigins(value, fallback) {
  const origins = value
    ? value.split(',').map((origin) => origin.trim()).filter(Boolean)
    : fallback;
  const normalizedOrigins = new Set();

  for (const origin of origins) {
    const normalizedOrigin = origin.replace(/\/$/, '');

    if (normalizedOrigin === '*') {
      normalizedOrigins.add(normalizedOrigin);
      continue;
    }

    if (/^https?:\/\//i.test(normalizedOrigin)) {
      normalizedOrigins.add(normalizedOrigin);
      continue;
    }

    normalizedOrigins.add(`http://${normalizedOrigin}`);
    normalizedOrigins.add(`https://${normalizedOrigin}`);
  }

  return [...normalizedOrigins];
}

function isAllowedOrigin(origin) {
  if (allowAnyOrigin || !origin) {
    return true;
  }

  const normalizedOrigin = origin.replace(/\/$/, '');

  if (allowedOrigins.includes(normalizedOrigin)) {
    return true;
  }

  return /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(normalizedOrigin);
}

async function getRecentReadings(limit) {
  const [rows] = await pool.query(
    `SELECT id, device_id AS deviceId, sensor_value AS sensorValue, status, created_at AS createdAt FROM sensor_readings ORDER BY created_at DESC, id DESC LIMIT ${limit}`
  );

  return rows;
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
