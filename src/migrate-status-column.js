const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

require('dotenv').config();

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: getSslConfig()
  });

  try {
    const columns = await getColumns(connection, 'sensor_readings', 'status');

    if (columns.length === 0) {
      await connection.query(
        "ALTER TABLE sensor_readings ADD COLUMN status ENUM('normal', 'warning', 'alarm') NOT NULL DEFAULT 'normal' AFTER sensor_value"
      );
      console.log('Added sensor_readings.status');
    } else {
      console.log('sensor_readings.status already exists');
    }

    await connection.query(
      `UPDATE sensor_readings
       SET status = CASE
         WHEN sensor_value >= 800 THEN 'alarm'
         WHEN sensor_value >= 600 THEN 'warning'
         ELSE 'normal'
       END`
    );
    console.log('Updated existing sensor_readings.status values');
  } finally {
    await connection.end();
  }
}

async function getColumns(connection, tableName, columnName) {
  const [columns] = await connection.execute(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ?
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [process.env.DB_NAME, tableName, columnName]
  );

  return columns;
}

function getSslConfig() {
  const sslEnabled = (process.env.DB_SSL || '').toLowerCase() === 'true';

  if (!sslEnabled) {
    return undefined;
  }

  const sslCaPath = process.env.DB_SSL_CA_PATH || 'certificates/db/caucp.pem';
  const resolvedSslCaPath = path.isAbsolute(sslCaPath) ? sslCaPath : path.resolve(process.cwd(), sslCaPath);
  const hasExplicitRejectUnauthorized = process.env.DB_SSL_REJECT_UNAUTHORIZED !== undefined && process.env.DB_SSL_REJECT_UNAUTHORIZED !== '';

  if (!fs.existsSync(resolvedSslCaPath)) {
    return {
      rejectUnauthorized: hasExplicitRejectUnauthorized
        ? process.env.DB_SSL_REJECT_UNAUTHORIZED.toLowerCase() === 'true'
        : false
    };
  }

  return {
    ca: fs.readFileSync(resolvedSslCaPath, 'utf8'),
    rejectUnauthorized: hasExplicitRejectUnauthorized
      ? process.env.DB_SSL_REJECT_UNAUTHORIZED.toLowerCase() === 'true'
      : true
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
