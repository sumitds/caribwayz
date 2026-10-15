const cron = require('node-cron');
const { query } = require('../config/db');
const weatherAlerts = require('./weatherAlertService');

// Auto-expire reports every 10 minutes
cron.schedule('*/10 * * * *', async () => {
  try {
    const result = await query(
      `UPDATE reports SET status = 'expired'
       WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at < NOW()`
    );
    if (result.rowCount > 0) {
      console.log(`[Cron] Expired ${result.rowCount} report(s)`);
    }
  } catch (err) {
    console.error('[Cron] Report expiry error:', err.message);
  }
});

console.log('[Cron] Report auto-expiry job scheduled (every 10 minutes)');

// Hurricane and tropical storm pushes. The NHC updates its feed at most every
// few minutes and issues advisories every three to six hours, so every 15
// minutes catches a new or strengthened storm promptly without hammering it.
let weatherCheckRunning = false;
cron.schedule('*/15 * * * *', async () => {
  // A slow feed must not let two checks overlap.
  if (weatherCheckRunning) return;
  weatherCheckRunning = true;
  try {
    await weatherAlerts.runCheck();
  } catch (err) {
    console.error('[Cron] Weather alert check error:', err.message);
  } finally {
    weatherCheckRunning = false;
  }
});

console.log('[Cron] Weather alert check scheduled (every 15 minutes)');
