const express = require('express');
const cors = require('cors');


const telemetryRoutes = require('./routes/telemetry.routes');

const app = express();

const allowedOrigins = [
  process.env.CORS_ORIGIN,
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:8100'
].filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('CORS origin not allowed'));
  }
}));

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    message: 'Smoke monitoring API running'
  });
});

app.use('/api/telemetry', telemetryRoutes);

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: 'Route not found'
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({
    ok: false,
    message: 'Internal server error'
  });
});

module.exports = app;
