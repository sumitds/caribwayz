require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : {
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
    };

const pool = new Pool(poolConfig);

const ADMIN_NAME     = process.env.ADMIN_NAME     || 'Admin';
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    || 'admin@caribwayz.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@1234';

const run = async () => {
  try {
    console.log('Connecting to database...');
    await pool.query('SELECT 1');

    const existing = await pool.query('SELECT id, role FROM users WHERE email = $1', [ADMIN_EMAIL]);

    if (existing.rows.length > 0) {
      if (existing.rows[0].role === 'admin') {
        console.log(`Admin already exists: ${ADMIN_EMAIL}`);
      } else {
        await pool.query('UPDATE users SET role = $1 WHERE email = $2', ['admin', ADMIN_EMAIL]);
        console.log(`Promoted existing user to admin: ${ADMIN_EMAIL}`);
      }
      await pool.end();
      return;
    }

    const password_hash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, auth_provider, role, status)
       VALUES ($1, $2, $3, 'email', 'admin', 'active')
       RETURNING id, name, email, role`,
      [ADMIN_NAME, ADMIN_EMAIL, password_hash]
    );

    await pool.query(
      'INSERT INTO user_preferences (user_id) VALUES ($1)',
      [result.rows[0].id]
    );

    console.log('\n✅ Admin user created successfully!');
    console.log('─────────────────────────────');
    console.log('Email   :', ADMIN_EMAIL);
    console.log('Password:', ADMIN_PASSWORD);
    console.log('Role    :', result.rows[0].role);
    console.log('─────────────────────────────');
    console.log('⚠️  Change this password after first login!\n');

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
};

run();
