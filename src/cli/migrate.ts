import { createPool, migrate } from '../db/pg.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = createPool(url);
try {
  const ran = await migrate(pool, process.env.MIGRATIONS_DIR ?? 'migrations');
  console.log(ran.length ? `applied: ${ran.join(', ')}` : 'database is up to date');
} finally {
  await pool.end();
}
