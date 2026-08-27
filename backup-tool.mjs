import { archiveStorageStatus, mirrorArchiveNow } from "./archive-store.mjs";

if (!process.env.BACKUP_DATABASE_URL) {
  console.error("BACKUP_DATABASE_URL is required. Create a standby PostgreSQL database and set its connection URL first.");
  process.exitCode = 2;
} else {
  try {
    const result = await mirrorArchiveNow();
    console.log(JSON.stringify({ ok: true, storage: archiveStorageStatus(), ...result }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message, storage: archiveStorageStatus() }));
    process.exitCode = 1;
  }
}
