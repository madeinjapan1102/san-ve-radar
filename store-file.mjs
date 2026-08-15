import fs from "node:fs/promises";
import path from "node:path";

const root = process.env.DATA_DIR || path.resolve(".data");
const file = path.join(root, "store.json");
const empty = { itineraries: [], quotes: [], notifications: [] };

export async function readStore() {
  await fs.mkdir(root, { recursive: true });
  try { return { ...empty, ...JSON.parse(await fs.readFile(file, "utf8")) }; }
  catch { await writeStore(empty); return structuredClone(empty); }
}

export async function writeStore(value) {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), "utf8");
}
