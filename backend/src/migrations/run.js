require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

// Build pool config — supports DATABASE_URL (Render/Neon/Supabase) or individual vars
const poolConfig = process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'caribwayz',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD,
    };

const pool = new Pool(poolConfig);

const run = async () => {
  console.log('Connecting to database...');
  try {
    await pool.query('SELECT 1');
    console.log('Connection successful.\n');
  } catch (err) {
    console.error('Cannot connect to database:', err.message);
    console.error('Check your DATABASE_URL or DB_* variables in .env');
    process.exit(1);
  }

  const migrationsDir = __dirname;
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`Running ${files.length} migration(s)...\n`);

  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    process.stdout.write(`  [${file}] ... `);
    try {
      await pool.query(sql);
      console.log('done');
    } catch (err) {
      console.log('FAILED');
      console.error(`  Error: ${err.message}`);
      process.exit(1);
    }
  }

  console.log('\nAll migrations completed successfully.');
  await pool.end();
  process.exit(0);
};

run();
