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

require('./src/services/cronService');

const app = express();

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

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
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

app.get('/api/v1/health', (req, res) => {
  res.json({ success: true, message: 'CaribWayz API is running', version: '1.0.0' });
});

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
app.listen(PORT, () => {
  console.log(`CaribWayz API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});
