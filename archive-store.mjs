import fs from "node:fs/promises";
import path from "node:path";

const root = process.env.DATA_DIR || path.resolve(".data");
const archiveFile = path.join(root, "fare-archive.json");
const blank = () => ({ version: 2, config: null, routes: [], targets: [], history: [], runs: [] });
const pools = new Map();
let activeDatabase = "file";
let lastMirror = { configured: false, ok: false, checkedAt: null, error: null };

async function postgresPool(envName) {
  const connectionString = process.env[envName];
  if (!connectionString) return null;
  if (!pools.has(envName)) {
    pools.set(envName, import("pg").then(({ default: pg }) => {
      const ssl = /localhost|127\.0\.0\.1/.test(connectionString) ? false : { rejectUnauthorized: false };
      return new pg.Pool({ connectionString, ssl, max: 3, connectionTimeoutMillis: 12_000 });
    }));
  }
  return pools.get(envName);
}

async function ensurePostgres(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS san_ve_archive (
    id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
}

async function readPostgres(envName) {
  const pool = await postgresPool(envName);
  if (!pool) return null;
  await ensurePostgres(pool);
  const result = await pool.query("SELECT payload FROM san_ve_archive WHERE id = 1");
  return result.rows[0]?.payload || blank();
}

async function writePostgres(envName, value) {
  const pool = await postgresPool(envName);
  if (!pool) return false;
  await ensurePostgres(pool);
  await pool.query(
    `INSERT INTO san_ve_archive (id, payload, updated_at) VALUES (1, $1::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [JSON.stringify(value)]
  );
  return true;
}

async function readFile() {
  await fs.mkdir(root, { recursive: true });
  try { return { ...blank(), ...JSON.parse(await fs.readFile(archiveFile, "utf8")) }; }
  catch { return blank(); }
}

async function writeFile(value) {
  await fs.mkdir(root, { recursive: true });
  const temp = `${archiveFile}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value), "utf8");
  await fs.rename(temp, archiveFile);
}

export async function readArchive() {
  if (process.env.DATABASE_URL) {
    try {
      const value = await readPostgres("DATABASE_URL");
      activeDatabase = "primary";
      return value;
    } catch (primaryError) {
      if (process.env.BACKUP_DATABASE_URL) {
        try {
          const value = await readPostgres("BACKUP_DATABASE_URL");
          activeDatabase = "backup";
          return value;
        } catch (backupError) {
          throw new Error(`Primary database failed: ${primaryError.message}; backup failed: ${backupError.message}`);
        }
      }
      throw primaryError;
    }
  }
  if (process.env.BACKUP_DATABASE_URL) {
    const value = await readPostgres("BACKUP_DATABASE_URL");
    activeDatabase = "backup";
    return value;
  }
  activeDatabase = "file";
  return readFile();
}

export async function writeArchive(value) {
  if (activeDatabase === "backup" && process.env.BACKUP_DATABASE_URL) {
    await writePostgres("BACKUP_DATABASE_URL", value);
    return;
  }
  if (process.env.DATABASE_URL) await writePostgres("DATABASE_URL", value);
  else if (process.env.BACKUP_DATABASE_URL) await writePostgres("BACKUP_DATABASE_URL", value);
  else await writeFile(value);

  if (process.env.DATABASE_URL && process.env.BACKUP_DATABASE_URL) {
    try {
      await writePostgres("BACKUP_DATABASE_URL", value);
      lastMirror = { configured: true, ok: true, checkedAt: new Date().toISOString(), error: null };
    } catch (error) {
      lastMirror = { configured: true, ok: false, checkedAt: new Date().toISOString(), error: error.message };
      console.error(`Archive mirror failed: ${error.message}`);
    }
  }
}

export async function mirrorArchiveNow() {
  if (!process.env.BACKUP_DATABASE_URL) throw new Error("BACKUP_DATABASE_URL is not configured");
  const value = process.env.DATABASE_URL ? await readPostgres("DATABASE_URL") : await readFile();
  await writePostgres("BACKUP_DATABASE_URL", value);
  lastMirror = { configured: true, ok: true, checkedAt: new Date().toISOString(), error: null };
  return {
    mirroredAt: lastMirror.checkedAt,
    routes: value.routes?.length || 0,
    targets: value.targets?.length || 0,
    historyRecords: value.history?.length || 0
  };
}

export function archiveStorageKind() {
  return process.env.DATABASE_URL || process.env.BACKUP_DATABASE_URL ? "postgresql" : "temporary-file";
}

export function archiveStorageStatus() {
  return {
    kind: archiveStorageKind(),
    active: activeDatabase,
    primaryConfigured: Boolean(process.env.DATABASE_URL),
    backupConfigured: Boolean(process.env.BACKUP_DATABASE_URL),
    automaticFailover: Boolean(process.env.BACKUP_DATABASE_URL),
    mirror: { ...lastMirror, configured: Boolean(process.env.BACKUP_DATABASE_URL) }
  };
}
