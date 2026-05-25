const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

require('dotenv').config();

const defaultSslCaPath = 'certificates/db/caucp.pem';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  ssl: getSslConfig()
});

function getSslConfig() {
  const sslEnabled = (process.env.DB_SSL || '').toLowerCase() === 'true';

  if (!sslEnabled) {
    return undefined;
  }

  const sslCaPath = process.env.DB_SSL_CA_PATH || defaultSslCaPath;
  const resolvedSslCaPath = resolvePath(sslCaPath);
  const hasExplicitRejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== undefined && process.env.DB_SSL_REJECT_UNAUTHORIZED !== '';
  const sslConfig = {};

  if (fs.existsSync(resolvedSslCaPath)) {
    sslConfig.ca = fs.readFileSync(resolvedSslCaPath, 'utf8');
    sslConfig.rejectUnauthorized = hasExplicitRejectUnauthorized
      ? process.env.DB_SSL_REJECT_UNAUTHORIZED.toLowerCase() === 'true'
      : true;

    return sslConfig;
  }

  if (process.env.DB_SSL_CA_PATH) {
    throw new Error(`DB_SSL_CA_PATH file not found: ${resolvedSslCaPath}`);
  }

  sslConfig.rejectUnauthorized = hasExplicitRejectUnauthorized
    ? process.env.DB_SSL_REJECT_UNAUTHORIZED.toLowerCase() === 'true'
    : false;

  return sslConfig;
}

function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

module.exports = pool;
