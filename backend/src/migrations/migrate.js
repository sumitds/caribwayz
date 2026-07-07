const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'caribwayz',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD,
    };

const runMigrations = async () => {
  const pool = new Pool(poolConfig);

  try {
    console.log('[Migrate] Connecting to database...');
    await pool.query('SELECT 1');
    console.log('[Migrate] Connected.');

    const migrationsDir = __dirname;
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      try {
        await pool.query(sql);
        console.log(`[Migrate] ${file} — ok`);
      } catch (err) {
        console.error(`[Migrate] ${file} — failed: ${err.message}`);
      }
    }

    // Seed admin account if not exists
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@caribwayz.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@1234';
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [adminEmail]);

    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash(adminPassword, 12);
      const result = await pool.query(
        `INSERT INTO users (name, email, password_hash, auth_provider, role, status)
         VALUES ($1, $2, $3, 'email', 'admin', 'active') RETURNING id`,
        ['Admin', adminEmail, hash]
      );
      await pool.query('INSERT INTO user_preferences (user_id) VALUES ($1)', [result.rows[0].id]);
      console.log(`[Migrate] Admin seeded: ${adminEmail}`);
    } else {
      console.log('[Migrate] Admin already exists — skipping seed.');
    }

  } catch (err) {
    console.error('[Migrate] Fatal error:', err.message);
  } finally {
    await pool.end();
  }
};

module.exports = runMigrations;
