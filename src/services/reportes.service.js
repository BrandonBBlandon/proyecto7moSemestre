const pool = require('../db');

const warningThreshold = Number(process.env.WARNING_THRESHOLD || 600);
const alarmThreshold = Number(process.env.ALARM_THRESHOLD || 800);

const READING_TABLE_CANDIDATES = [
  'sensor_readings',
  'lecturas',
  'readings',
  'registros',
  'smoke_readings'
];

const INCIDENT_TABLE_CANDIDATES = [
  'incidentes',
  'incidents',
  'eventos',
  'alerts'
];

const COLUMN_CANDIDATES = {
  id: ['id', 'reading_id'],
  device: ['device_id', 'deviceId', 'device'],
  value: ['sensor_value', 'valor', 'smoke_value', 'mq_value', 'raw_value', 'processed_value'],
  status: ['status', 'estado', 'risk_level'],
  createdAt: ['created_at', 'fecha', 'timestamp', 'createdAt'],
  incidentStart: ['started_at', 'start_at', 'start_time', 'fecha_inicio', 'created_at', 'fecha', 'timestamp'],
  incidentEnd: ['ended_at', 'end_at', 'end_time', 'fecha_fin', 'resolved_at', 'closed_at', 'updated_at'],
  incidentDuration: ['duration_seconds', 'total_alarm_seconds', 'alarm_seconds', 'duracion_segundos', 'duration'],
  incidentMaxValue: ['max_smoke_value', 'max_sensor_value', 'max_value', 'valor_maximo', 'sensor_value', 'smoke_value']
};

let schemaCache = null;

async function getDailyReport(date) {
  const schema = await getSchema();
  const summary = await getSummary(schema, date, date);
  const incidentTotals = await getIncidentTotals(schema, date, date);
  const fallbackIncidents = schema.incidents ? new Map() : await getReadingIncidentCountsByDay(schema, date, date);
  const items = await getReadings(schema, date, date, 500);

  return {
    ok: true,
    date,
    summary: mergeSummary(summary, getDayIncidentTotals(date, incidentTotals, fallbackIncidents)),
    items
  };
}

async function getRangeReport(from, to) {
  const schema = await getSchema();
  const rows = await getByDay(schema, from, to);
  const incidentTotals = await getIncidentTotals(schema, from, to);
  const fallbackIncidents = schema.incidents ? new Map() : await getReadingIncidentCountsByDay(schema, from, to);
  const items = mergeDailyRows(rows, incidentTotals, fallbackIncidents);

  return {
    ok: true,
    from,
    to,
    items
  };
}

async function getMonthlyReport(year, month) {
  const monthNumber = Number(month);
  const startDate = `${year}-${String(monthNumber).padStart(2, '0')}-01`;
  const endDate = addMonths(startDate, 1);
  const schema = await getSchema();
  const summary = await getSummary(schema, startDate, endDate, { endExclusive: true });
  const incidentTotals = await getIncidentTotals(schema, startDate, endDate, { endExclusive: true });
  const rows = await getByDay(schema, startDate, endDate, { endExclusive: true });
  const fallbackIncidents = schema.incidents
    ? new Map()
    : await getReadingIncidentCountsByDay(schema, startDate, endDate, { endExclusive: true });
  const items = mergeDailyRows(rows, incidentTotals, fallbackIncidents);

  return {
    ok: true,
    year: Number(year),
    month: monthNumber,
    summary: mergeSummary(summary, sumIncidentTotals(incidentTotals, fallbackIncidents)),
    items
  };
}

async function getLatestReadings(limit) {
  const schema = await getSchema();
  const items = await getLatest(schema, limit);

  return {
    ok: true,
    limit,
    items
  };
}

async function getSchema() {
  if (schemaCache) {
    return schemaCache;
  }

  const readingsTable = await findFirstExistingTable(READING_TABLE_CANDIDATES);

  if (!readingsTable) {
    throw new Error(`No se encontro tabla de lecturas. Buscadas: ${READING_TABLE_CANDIDATES.join(', ')}`);
  }

  const readingColumns = await getColumns(readingsTable);
  const valueColumn = pickColumn(readingColumns, COLUMN_CANDIDATES.value);
  const createdAtColumn = pickColumn(readingColumns, COLUMN_CANDIDATES.createdAt);

  if (!valueColumn) {
    throw new Error(`La tabla ${readingsTable} no tiene columna de valor de humo compatible`);
  }

  if (!createdAtColumn) {
    throw new Error(`La tabla ${readingsTable} no tiene columna de fecha compatible`);
  }

  const incidentsTable = await findFirstExistingTable(INCIDENT_TABLE_CANDIDATES);
  let incidents = null;

  if (incidentsTable) {
    const incidentColumns = await getColumns(incidentsTable);
    const startColumn = pickColumn(incidentColumns, COLUMN_CANDIDATES.incidentStart);

    if (startColumn) {
      incidents = {
        table: incidentsTable,
        columns: {
          start: startColumn,
          end: pickColumn(incidentColumns, COLUMN_CANDIDATES.incidentEnd),
          duration: pickColumn(incidentColumns, COLUMN_CANDIDATES.incidentDuration),
          maxValue: pickColumn(incidentColumns, COLUMN_CANDIDATES.incidentMaxValue)
        }
      };
    }
  }

  schemaCache = {
    readings: {
      table: readingsTable,
      columns: {
        id: pickColumn(readingColumns, COLUMN_CANDIDATES.id),
        device: pickColumn(readingColumns, COLUMN_CANDIDATES.device),
        value: valueColumn,
        status: pickColumn(readingColumns, COLUMN_CANDIDATES.status),
        createdAt: createdAtColumn
      }
    },
    incidents
  };

  console.log('[REPORTES] schema:', JSON.stringify(schemaCache));

  return schemaCache;
}

async function findFirstExistingTable(candidates) {
  const placeholders = candidates.map(() => '?').join(', ');
  const [rows] = await pool.execute(
    `SELECT TABLE_NAME AS tableName
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (${placeholders})`,
    candidates
  );
  const existing = new Set(rows.map((row) => row.tableName));

  return candidates.find((candidate) => existing.has(candidate)) || null;
}

async function getColumns(tableName) {
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME AS columnName
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName]
  );

  return rows.map((row) => row.columnName);
}

async function getSummary(schema, from, to, options = {}) {
  const table = quoteIdentifier(schema.readings.table);
  const createdAt = quoteIdentifier(schema.readings.columns.createdAt);
  const valueExpression = getValueExpression(schema);
  const statusExpression = getStatusExpression(schema);
  const rangeSql = getRangeSql(createdAt, options.endExclusive);
  const params = options.endExclusive ? [from, to] : [from, to];
  const [rows] = await pool.execute(
    `SELECT
       COUNT(*) AS totalReadings,
       COALESCE(SUM(CASE WHEN ${statusExpression} = 'alarm' THEN 1 ELSE 0 END), 0) AS alarmReadings,
       COALESCE(SUM(CASE WHEN ${statusExpression} = 'warning' THEN 1 ELSE 0 END), 0) AS warningReadings,
       COALESCE(SUM(CASE WHEN ${statusExpression} = 'normal' THEN 1 ELSE 0 END), 0) AS normalReadings,
       COALESCE(MAX(${valueExpression}), 0) AS maxSmokeValue,
       COALESCE(AVG(${valueExpression}), 0) AS avgSmokeValue
     FROM ${table}
     WHERE ${rangeSql}`,
    params
  );

  return formatSummary(rows[0]);
}

async function getByDay(schema, from, to, options = {}) {
  const table = quoteIdentifier(schema.readings.table);
  const createdAt = quoteIdentifier(schema.readings.columns.createdAt);
  const valueExpression = getValueExpression(schema);
  const statusExpression = getStatusExpression(schema);
  const rangeSql = getRangeSql(createdAt, options.endExclusive);
  const [rows] = await pool.execute(
    `SELECT
       DATE_FORMAT(${createdAt}, '%Y-%m-%d') AS date,
       COUNT(*) AS totalReadings,
       COALESCE(SUM(CASE WHEN ${statusExpression} = 'alarm' THEN 1 ELSE 0 END), 0) AS alarmReadings,
       COALESCE(SUM(CASE WHEN ${statusExpression} = 'warning' THEN 1 ELSE 0 END), 0) AS warningReadings,
       COALESCE(SUM(CASE WHEN ${statusExpression} = 'normal' THEN 1 ELSE 0 END), 0) AS normalReadings,
       COALESCE(MAX(${valueExpression}), 0) AS maxSmokeValue,
       COALESCE(AVG(${valueExpression}), 0) AS avgSmokeValue
     FROM ${table}
     WHERE ${rangeSql}
     GROUP BY DATE(${createdAt})
     ORDER BY date ASC`,
    [from, to]
  );

  return rows.map(formatSummary);
}

async function getReadings(schema, from, to, limit) {
  const selectSql = getReadingSelectSql(schema);
  const table = quoteIdentifier(schema.readings.table);
  const createdAt = quoteIdentifier(schema.readings.columns.createdAt);
  const rangeSql = getRangeSql(createdAt, false);
  const [rows] = await pool.execute(
    `${selectSql}
     FROM ${table}
     WHERE ${rangeSql}
     ORDER BY ${createdAt} ASC
     LIMIT ${Number(limit)}`,
    [from, to]
  );

  return rows.map(formatReading);
}

async function getLatest(schema, limit) {
  const selectSql = getReadingSelectSql(schema);
  const table = quoteIdentifier(schema.readings.table);
  const id = schema.readings.columns.id ? quoteIdentifier(schema.readings.columns.id) : null;
  const createdAt = quoteIdentifier(schema.readings.columns.createdAt);
  const orderSql = id ? `${createdAt} DESC, ${id} DESC` : `${createdAt} DESC`;
  const [rows] = await pool.query(
    `${selectSql}
     FROM ${table}
     ORDER BY ${orderSql}
     LIMIT ${Number(limit)}`
  );

  return rows.map(formatReading);
}

async function getIncidentTotals(schema, from, to, options = {}) {
  if (!schema.incidents) {
    return new Map();
  }

  const table = quoteIdentifier(schema.incidents.table);
  const start = quoteIdentifier(schema.incidents.columns.start);
  const durationExpression = getIncidentDurationExpression(schema);
  const maxValueExpression = schema.incidents.columns.maxValue
    ? quoteIdentifier(schema.incidents.columns.maxValue)
    : '0';
  const rangeSql = getRangeSql(start, options.endExclusive);
  const [rows] = await pool.execute(
    `SELECT
       DATE_FORMAT(${start}, '%Y-%m-%d') AS date,
       COUNT(*) AS totalIncidents,
       COALESCE(SUM(${durationExpression}), 0) AS totalAlarmSeconds,
       COALESCE(MAX(${maxValueExpression}), 0) AS maxSmokeValue
     FROM ${table}
     WHERE ${rangeSql}
     GROUP BY DATE(${start})`,
    [from, to]
  );

  return new Map(rows.map((row) => [row.date, formatIncidentTotals(row)]));
}

async function getReadingIncidentCountsByDay(schema, from, to, options = {}) {
  const table = quoteIdentifier(schema.readings.table);
  const createdAt = quoteIdentifier(schema.readings.columns.createdAt);
  const statusExpression = getStatusExpression(schema);
  const id = schema.readings.columns.id ? quoteIdentifier(schema.readings.columns.id) : null;
  const rangeSql = getRangeSql(createdAt, options.endExclusive);
  const orderSql = id ? `${createdAt} ASC, ${id} ASC` : `${createdAt} ASC`;
  const [rows] = await pool.execute(
    `SELECT DATE_FORMAT(${createdAt}, '%Y-%m-%d') AS date, ${statusExpression} AS status
     FROM ${table}
     WHERE ${rangeSql}
     ORDER BY ${orderSql}`,
    [from, to]
  );
  const totals = new Map();
  let previousWasAlarmByDate = new Map();

  // Si no hay tabla de incidentes, se infieren eventos por transiciones a "alarm".
  // La duracion real debe venir de una tabla de incidentes con inicio/fin/duracion.
  for (const row of rows) {
    const current = totals.get(row.date) || {
      date: row.date,
      totalIncidents: 0,
      totalAlarmSeconds: 0,
      maxSmokeValue: 0
    };
    const previousWasAlarm = previousWasAlarmByDate.get(row.date) || false;
    const isAlarm = row.status === 'alarm';

    if (isAlarm && !previousWasAlarm) {
      current.totalIncidents += 1;
    }

    previousWasAlarmByDate.set(row.date, isAlarm);
    totals.set(row.date, current);
  }

  return totals;
}

function getReadingSelectSql(schema) {
  const columns = schema.readings.columns;
  const id = columns.id ? `${quoteIdentifier(columns.id)} AS id,` : 'NULL AS id,';
  const device = columns.device ? `${quoteIdentifier(columns.device)} AS deviceId,` : 'NULL AS deviceId,';
  const value = `${getValueExpression(schema)} AS smokeValue,`;
  const status = `${getStatusExpression(schema)} AS status,`;
  const createdAt = `${quoteIdentifier(columns.createdAt)} AS createdAt`;

  return `SELECT ${id} ${device} ${value} ${status} ${createdAt}`;
}

function getStatusExpression(schema) {
  const valueExpression = getValueExpression(schema);
  const fallback = `CASE
    WHEN ${valueExpression} >= ${Number(alarmThreshold)} THEN 'alarm'
    WHEN ${valueExpression} >= ${Number(warningThreshold)} THEN 'warning'
    ELSE 'normal'
  END`;

  if (!schema.readings.columns.status) {
    return fallback;
  }

  const status = `LOWER(CAST(${quoteIdentifier(schema.readings.columns.status)} AS CHAR))`;

  return `CASE
    WHEN ${status} IN ('alarm', 'alarma') THEN 'alarm'
    WHEN ${status} IN ('warning', 'warn', 'advertencia') THEN 'warning'
    WHEN ${status} = 'normal' THEN 'normal'
    ELSE ${fallback}
  END`;
}

function getValueExpression(schema) {
  return `COALESCE(${quoteIdentifier(schema.readings.columns.value)}, 0)`;
}

function getIncidentDurationExpression(schema) {
  if (schema.incidents.columns.duration) {
    return `COALESCE(${quoteIdentifier(schema.incidents.columns.duration)}, 0)`;
  }

  if (schema.incidents.columns.end) {
    return `GREATEST(TIMESTAMPDIFF(SECOND, ${quoteIdentifier(schema.incidents.columns.start)}, ${quoteIdentifier(schema.incidents.columns.end)}), 0)`;
  }

  return '0';
}

function getRangeSql(column, endExclusive) {
  if (endExclusive) {
    return `${column} >= ? AND ${column} < ?`;
  }

  return `${column} >= ? AND ${column} < DATE_ADD(?, INTERVAL 1 DAY)`;
}

function mergeDailyRows(rows, incidentTotals, fallbackIncidents) {
  const dates = new Set([
    ...rows.map((row) => row.date),
    ...incidentTotals.keys(),
    ...fallbackIncidents.keys()
  ]);

  return [...dates].sort().map((date) => {
    const row = rows.find((item) => item.date === date) || emptyDay(date);
    const incidents = getDayIncidentTotals(date, incidentTotals, fallbackIncidents);

    return mergeSummary(row, incidents);
  });
}

function mergeSummary(summary, incidents) {
  const maxSmokeValue = Math.max(number(summary.maxSmokeValue), number(incidents.maxSmokeValue));
  const merged = {
    date: summary.date,
    totalReadings: number(summary.totalReadings),
    totalIncidents: number(incidents.totalIncidents),
    alarmReadings: number(summary.alarmReadings),
    warningReadings: number(summary.warningReadings),
    normalReadings: number(summary.normalReadings),
    totalAlarmSeconds: number(incidents.totalAlarmSeconds),
    maxSmokeValue,
    avgSmokeValue: round(summary.avgSmokeValue)
  };

  merged.riskLevel = getRiskLevel(merged);

  if (!merged.date) {
    delete merged.date;
  }

  return merged;
}

function getDayIncidentTotals(date, incidentTotals, fallbackIncidents) {
  return incidentTotals.get(date) || fallbackIncidents.get(date) || {
    totalIncidents: 0,
    totalAlarmSeconds: 0,
    maxSmokeValue: 0
  };
}

function sumIncidentTotals(incidentTotals, fallbackIncidents) {
  const totals = {
    totalIncidents: 0,
    totalAlarmSeconds: 0,
    maxSmokeValue: 0
  };
  const source = incidentTotals.size > 0 ? incidentTotals : fallbackIncidents;

  for (const row of source.values()) {
    totals.totalIncidents += number(row.totalIncidents);
    totals.totalAlarmSeconds += number(row.totalAlarmSeconds);
    totals.maxSmokeValue = Math.max(totals.maxSmokeValue, number(row.maxSmokeValue));
  }

  return totals;
}

function formatSummary(row) {
  return {
    date: row.date,
    totalReadings: number(row.totalReadings),
    alarmReadings: number(row.alarmReadings),
    warningReadings: number(row.warningReadings),
    normalReadings: number(row.normalReadings),
    maxSmokeValue: number(row.maxSmokeValue),
    avgSmokeValue: round(row.avgSmokeValue)
  };
}

function formatIncidentTotals(row) {
  return {
    date: row.date,
    totalIncidents: number(row.totalIncidents),
    totalAlarmSeconds: number(row.totalAlarmSeconds),
    maxSmokeValue: number(row.maxSmokeValue)
  };
}

function formatReading(row) {
  return {
    id: row.id,
    deviceId: row.deviceId,
    smokeValue: number(row.smokeValue),
    sensorValue: number(row.smokeValue),
    status: row.status,
    riskLevel: row.status,
    createdAt: row.createdAt
  };
}

function emptyDay(date) {
  return {
    date,
    totalReadings: 0,
    alarmReadings: 0,
    warningReadings: 0,
    normalReadings: 0,
    maxSmokeValue: 0,
    avgSmokeValue: 0
  };
}

function getRiskLevel(summary) {
  if (summary.alarmReadings > 0 || summary.totalIncidents > 0) {
    return 'alarm';
  }

  if (summary.warningReadings > 0) {
    return 'warning';
  }

  return 'normal';
}

function pickColumn(existingColumns, candidates) {
  const lowerMap = new Map(existingColumns.map((column) => [column.toLowerCase(), column]));

  for (const candidate of candidates) {
    const column = lowerMap.get(candidate.toLowerCase());

    if (column) {
      return column;
    }
  }

  return null;
}

function quoteIdentifier(value) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`Identificador SQL invalido: ${value}`);
  }

  return `\`${value}\``;
}

function addMonths(date, months) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1 + months, day));

  return value.toISOString().slice(0, 10);
}

function number(value) {
  if (value === null || value === undefined) {
    return 0;
  }

  return Number(value);
}

function round(value) {
  return Number(number(value).toFixed(2));
}

module.exports = {
  getDailyReport,
  getRangeReport,
  getMonthlyReport,
  getLatestReadings
};
