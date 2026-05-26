const reportesService = require('../services/reportes.service');

function index(req, res) {
  if (req.query.type) {
    return dispatchLegacyType(req, res);
  }

  return res.json({
    ok: true,
    routes: [
      'GET /api/reportes/daily',
      'GET /api/reportes/range?from=YYYY-MM-DD&to=YYYY-MM-DD',
      'GET /api/reportes/monthly?year=YYYY&month=M',
      'GET /api/reportes/latest?limit=10'
    ]
  });
}

async function daily(req, res) {
  console.log('[REPORTES] GET /daily', req.query);

  try {
    const date = req.query.date || getServerDate();

    if (!isValidDate(date)) {
      return res.status(400).json({
        ok: false,
        message: 'date debe tener formato YYYY-MM-DD'
      });
    }

    const report = await reportesService.getDailyReport(date);

    return res.json(report);
  } catch (error) {
    return handleReportError(res, error, 'Error al generar reporte diario');
  }
}

async function range(req, res) {
  console.log('[REPORTES] GET /range', req.query);

  try {
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        ok: false,
        message: 'from y to son requeridos'
      });
    }

    if (!isValidDate(from) || !isValidDate(to) || from > to) {
      return res.status(400).json({
        ok: false,
        message: 'from y to deben tener formato YYYY-MM-DD y un rango valido'
      });
    }

    const report = await reportesService.getRangeReport(from, to);

    return res.json(report);
  } catch (error) {
    return handleReportError(res, error, 'Error al generar reporte por rango');
  }
}

async function monthly(req, res) {
  console.log('[REPORTES] GET /monthly', req.query);

  try {
    let { year, month } = req.query;

    if (!year && isValidYearMonth(month)) {
      const parts = month.split('-');
      year = parts[0];
      month = parts[1];
    }

    if (!isValidYear(year) || !isValidMonth(month)) {
      return res.status(400).json({
        ok: false,
        message: 'year y month deben ser numeros validos'
      });
    }

    const report = await reportesService.getMonthlyReport(Number(year), Number(month));

    return res.json(report);
  } catch (error) {
    return handleReportError(res, error, 'Error al generar reporte mensual');
  }
}

async function latest(req, res) {
  console.log('[REPORTES] GET /latest', req.query);

  try {
    const limit = getLimit(req.query.limit, 10, 100);
    const report = await reportesService.getLatestReadings(limit);

    return res.json(report);
  } catch (error) {
    return handleReportError(res, error, 'Error al consultar ultimos registros');
  }
}

function dispatchLegacyType(req, res) {
  const type = String(req.query.type || '').toLowerCase();

  if (type === 'daily') {
    return daily(req, res);
  }

  if (type === 'range') {
    return range(req, res);
  }

  if (type === 'monthly') {
    return monthly(req, res);
  }

  if (type === 'latest' || type === 'recent') {
    return latest(req, res);
  }

  return res.status(400).json({
    ok: false,
    message: 'type es invalido'
  });
}

function handleReportError(res, error, message) {
  console.error('[REPORTES] error:', error);

  const payload = {
    ok: false,
    message
  };

  if (process.env.NODE_ENV !== 'production') {
    payload.error = error && error.message ? error.message : 'Unexpected error';
  }

  return res.status(getErrorStatus(error)).json(payload);
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

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return date.toISOString().slice(0, 10) === value;
}

function isValidYear(value) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed >= 2000 && parsed <= 2100;
}

function isValidMonth(value) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 12;
}

function isValidYearMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value));
}

function getLimit(value, fallback, max) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function getServerDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

module.exports = {
  index,
  daily,
  range,
  monthly,
  latest
};
