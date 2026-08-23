import fs from "node:fs/promises";
import path from "node:path";

const root = process.env.DATA_DIR || path.resolve(".data");
const archiveFile = path.join(root, "fare-archive.json");
const blank = () => ({ version: 1, config: null, targets: [], history: [], runs: [] });
let poolPromise;

async function postgresPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!poolPromise) poolPromise = import("pg").then(({ default: pg }) => {
    const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false };
    return new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 3 });
  });
  return poolPromise;
}

async function ensurePostgres(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS san_ve_archive (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
}

export async function readArchive() {
  const pool = await postgresPool();
  if (pool) {
    await ensurePostgres(pool);
    const result = await pool.query("SELECT payload FROM san_ve_archive WHERE id = 1");
    return result.rows[0]?.payload || blank();
  }
  await fs.mkdir(root, { recursive: true });
  try { return { ...blank(), ...JSON.parse(await fs.readFile(archiveFile, "utf8")) }; }
  catch { return blank(); }
}

export async function writeArchive(value) {
  const pool = await postgresPool();
  if (pool) {
    await ensurePostgres(pool);
    await pool.query(
      `INSERT INTO san_ve_archive (id, payload, updated_at) VALUES (1, $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [JSON.stringify(value)]
    );
    return;
  }
  await fs.mkdir(root, { recursive: true });
  const temp = `${archiveFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), "utf8");
  await fs.rename(temp, archiveFile);
}

export function archiveStorageKind() {
  return process.env.DATABASE_URL ? "postgresql" : "temporary-file";
}
