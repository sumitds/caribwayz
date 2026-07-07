const cron = require('node-cron');
const { query } = require('../config/db');

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
