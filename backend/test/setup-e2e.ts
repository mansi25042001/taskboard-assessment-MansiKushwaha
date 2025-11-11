// Create a temp SQLite file and set process.env.DATABASE_URL so the app uses it.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export default async function globalSetup() {
  // Unique file per run
  const dbFile = path.join(os.tmpdir(), `test-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  // Ensure file exists (Prisma/SQLite will create it on connect, but touch it for clarity)
  try {
    fs.writeFileSync(dbFile, '');
  } catch (e) {
    // ignore
  }

  // Make the DB URL available to tests and the app. Use sqlite file URL format Prisma expects.
  process.env.DATABASE_URL = `file:${dbFile}`;
  // Also write path to known env so teardown can find it if needed.
  process.env.__E2E_TEMP_DB_FILE = dbFile;

  // If you need to run prisma db push programmatically before tests, you could spawn
  // `npx prisma db push` here. Typically CI will run migrations
  // or your AppModule will auto-create tables in test mode if supported.
  // Example (uncomment if you want to attempt db push):
  // const { execSync } = require('child_process');
  // execSync('npx prisma db push', { stdio: 'inherit', env: process.env });
}
