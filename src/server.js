require('dotenv').config();

const express = require('express');
const cors = require('cors');
const pool = require('./db');

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
    if (allowAnyOrigin || !origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(null, false);
  }
}));

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'API is running'
  });
});

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

app.get('/api/reports', reportHandler);

app.get('/api/reports/:type', reportHandler);

async function reportHandler(req, res) {
  try {
    const type = req.params.type || req.query.type;

    if (!type) {
      return res.status(400).json({
        ok: false,
        message: 'type is required'
      });
    }

    if (type === 'daily') {
      return getDailyReport(req, res);
    }

    if (type === 'range') {
      return getRangeReport(req, res);
    }

    if (type === 'monthly') {
      return getMonthlyReport(req, res);
    }

    if (type === 'recent') {
      return getRecentReport(req, res);
    }

    res.status(400).json({
      ok: false,
      message: 'type is invalid'
    });
  } catch (error) {
    console.error(error);
    sendError(res, error);
  }
}

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

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return date.toISOString().slice(0, 10) === value;
}

function isValidMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function number(value) {
  return value === null || value === undefined ? 0 : Number(value);
}

function round(value) {
  return Number(number(value).toFixed(2));
}

function percentage(value, total) {
  return total > 0 ? round((value * 100) / total) : 0;
}

function formatSummary(row) {
  const totalReadings = number(row.totalReadings);
  const warningCount = number(row.warningCount);
  const alarmCount = number(row.alarmCount);

  return {
    totalReadings,
    averageValue: round(row.averageValue),
    maxValue: number(row.maxValue),
    minValue: number(row.minValue),
    normalCount: number(row.normalCount),
    warningCount,
    alarmCount,
    warningPercentage: percentage(warningCount, totalReadings),
    alarmPercentage: percentage(alarmCount, totalReadings)
  };
}

function formatDay(row) {
  return {
    date: row.date,
    totalReadings: number(row.totalReadings),
    averageValue: round(row.averageValue),
    maxValue: number(row.maxValue),
    minValue: number(row.minValue),
    normalCount: number(row.normalCount),
    warningCount: number(row.warningCount),
    alarmCount: number(row.alarmCount)
  };
}

async function getSummary(whereSql, params) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS totalReadings, AVG(sensor_value) AS averageValue, MAX(sensor_value) AS maxValue, MIN(sensor_value) AS minValue, COALESCE(SUM(CASE WHEN status = 'normal' THEN 1 ELSE 0 END), 0) AS normalCount, COALESCE(SUM(CASE WHEN status = 'warning' THEN 1 ELSE 0 END), 0) AS warningCount, COALESCE(SUM(CASE WHEN status = 'alarm' THEN 1 ELSE 0 END), 0) AS alarmCount FROM sensor_readings WHERE ${whereSql}`,
    params
  );

  return formatSummary(rows[0]);
}

async function getByDay(whereSql, params) {
  const [rows] = await pool.execute(
    `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS date, COUNT(*) AS totalReadings, AVG(sensor_value) AS averageValue, MAX(sensor_value) AS maxValue, MIN(sensor_value) AS minValue, COALESCE(SUM(CASE WHEN status = 'normal' THEN 1 ELSE 0 END), 0) AS normalCount, COALESCE(SUM(CASE WHEN status = 'warning' THEN 1 ELSE 0 END), 0) AS warningCount, COALESCE(SUM(CASE WHEN status = 'alarm' THEN 1 ELSE 0 END), 0) AS alarmCount FROM sensor_readings WHERE ${whereSql} GROUP BY DATE(created_at) ORDER BY date ASC`,
    params
  );

  return rows.map(formatDay);
}

async function getRecentReadings(limit) {
  const [rows] = await pool.query(
    `SELECT id, device_id AS deviceId, sensor_value AS sensorValue, status, created_at AS createdAt FROM sensor_readings ORDER BY created_at DESC, id DESC LIMIT ${limit}`
  );

  return rows;
}

async function getDailyReport(req, res) {
  const { date } = req.query;

  if (!date) {
    return res.status(400).json({
      ok: false,
      message: 'date is required'
    });
  }

  if (!isValidDate(date)) {
    return res.status(400).json({
      ok: false,
      message: 'date is invalid'
    });
  }

  const summary = await getSummary('created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)', [date, date]);

  res.json({
    ok: true,
    type: 'daily',
    data: {
      date,
      ...summary
    }
  });
}

async function getRangeReport(req, res) {
  const { from, to } = req.query;

  if (!from || !to) {
    return res.status(400).json({
      ok: false,
      message: 'from and to are required'
    });
  }

  if (!isValidDate(from) || !isValidDate(to) || from > to) {
    return res.status(400).json({
      ok: false,
      message: 'date range is invalid'
    });
  }

  const whereSql = 'created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 DAY)';
  const params = [from, to];
  const summary = await getSummary(whereSql, params);
  const byDay = await getByDay(whereSql, params);

  res.json({
    ok: true,
    type: 'range',
    data: {
      from,
      to,
      summary,
      byDay
    }
  });
}

async function getMonthlyReport(req, res) {
  const { month } = req.query;

  if (!month) {
    return res.status(400).json({
      ok: false,
      message: 'month is required'
    });
  }

  if (!isValidMonth(month)) {
    return res.status(400).json({
      ok: false,
      message: 'month is invalid'
    });
  }

  const startDate = `${month}-01`;
  const whereSql = 'created_at >= ? AND created_at < DATE_ADD(?, INTERVAL 1 MONTH)';
  const params = [startDate, startDate];
  const summary = await getSummary(whereSql, params);
  const byDay = await getByDay(whereSql, params);

  res.json({
    ok: true,
    type: 'monthly',
    data: {
      month,
      summary,
      byDay
    }
  });
}

async function getRecentReport(req, res) {
  const limit = getLimit(req.query.limit, Math.min(defaultRecentLimit, 50), 50);
  const rows = await getRecentReadings(limit);

  const totalReadings = rows.length;
  const values = rows.map((row) => number(row.sensorValue));
  const normalCount = rows.filter((row) => row.status === 'normal').length;
  const warningCount = rows.filter((row) => row.status === 'warning').length;
  const alarmCount = rows.filter((row) => row.status === 'alarm').length;
  const averageValue = totalReadings > 0 ? round(values.reduce((sum, value) => sum + value, 0) / totalReadings) : 0;
  const maxValue = totalReadings > 0 ? Math.max(...values) : 0;
  const minValue = totalReadings > 0 ? Math.min(...values) : 0;
  const warningPercentage = percentage(warningCount, totalReadings);
  const alarmPercentage = percentage(alarmCount, totalReadings);
  const unusual = alarmCount > 0 || warningPercentage >= 50 || averageValue > warningThreshold;
  const possibleEvent = alarmCount > 0 ? 'possible_fire_or_high_gas' : unusual ? 'possible_gas_leak' : 'normal';

  res.json({
    ok: true,
    type: 'recent',
    data: {
      limit,
      totalReadings,
      averageValue,
      maxValue,
      minValue,
      normalCount,
      warningCount,
      alarmCount,
      warningPercentage,
      alarmPercentage,
      unusual,
      possibleEvent,
      readings: rows
    }
  });
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
