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

    // Seed admin account if not exists.
    //
    // There are deliberately no fallback credentials. runMigrations() executes
    // on every boot, so a default email and password here is a live admin login
    // on the deployed instance, published in the repository. An admin can grant
    // emergency-responder access, which reads the live location of every person
    // currently in an emergency, so this fails loudly rather than quietly
    // seeding something guessable.
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;

    if (!adminEmail || !adminPassword) {
      console.warn(
        '[Migrate] ADMIN_EMAIL and ADMIN_PASSWORD are not both set - skipping admin seed. ' +
        'Set them in the environment to create the first administrator.'
      );
      return;
    }

    if (adminPassword.length < 12) {
      console.error(
        '[Migrate] ADMIN_PASSWORD is shorter than 12 characters - refusing to seed the admin account.'
      );
      return;
    }

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
