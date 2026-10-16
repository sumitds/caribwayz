require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./src/config/swagger');

// Initialize Firebase before anything else
const { initFirebase } = require('./src/config/firebase');
initFirebase();

const { initWebSocket } = require('./src/services/wsService');

const authRoutes = require('./src/routes/auth');
const userRoutes = require('./src/routes/user');
const routeRoutes = require('./src/routes/routes');
const poiRoutes = require('./src/routes/pois');
const reportRoutes = require('./src/routes/reports');
const emergencyRoutes = require('./src/routes/emergency');
const groupRoutes = require('./src/routes/groups');
const notificationRoutes = require('./src/routes/notifications');
const adminRoutes = require('./src/routes/admin');
const recordRoutes = require('./src/routes/records');
const providerRoutes = require('./src/routes/providers');
const { seedRoadsidePlaces } = require('./src/services/roadsidePlaces');
const shelterRoutes = require('./src/routes/shelters');
const { seedEmergencyShelters } = require('./src/services/emergencyShelters');
const db = require('./src/config/db');

require('./src/services/cronService');
const runMigrations = require('./src/migrations/migrate');

const app = express();

// Render terminates connections at its proxy, so without this req.ip is the
// proxy's address for every caller and each per-IP rate limit becomes one
// bucket shared by all users. 1 trusts exactly the hop Render adds to
// X-Forwarded-For; entries a client puts there itself are still ignored.
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customSiteTitle: 'CaribWayz API Docs',
  customCss: '.swagger-ui .topbar { background-color: #1a1a2e; } .swagger-ui .topbar-wrapper img { content: none; }',
}));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check must be before rate limiter — Render pings this every ~30s
// and the limiter would return 429, causing repeated 502 Bad Gateway errors.
app.get('/api/v1/health', (req, res) => {
  res.json({ success: true, message: 'CaribWayz API is running', version: '1.0.0' });
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  skip: (req) => req.path === '/api/v1/health',
  message: { success: false, message: 'Too many requests, please try again later.' },
});
app.use('/api/', limiter);

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/user', userRoutes);
app.use('/api/v1/routes', routeRoutes);
app.use('/api/v1/pois', poiRoutes);
app.use('/api/v1/reports', reportRoutes);
app.use('/api/v1/emergency', emergencyRoutes);
app.use('/api/v1/groups', groupRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/admin', adminRoutes);
app.use('/api/v1/records', recordRoutes);
app.use('/api/v1/providers', providerRoutes);
app.use('/api/v1/shelters', shelterRoutes);

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal Server Error',
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

const PORT = process.env.PORT || 5000;

runMigrations().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`CaribWayz API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
  });
  initWebSocket(server);
  // After listening, so a slow first load never delays the health check.
  // Never throws; on failure the table keeps whatever it already held.
  seedRoadsidePlaces(db.query);
  seedEmergencyShelters(db.query);
});
