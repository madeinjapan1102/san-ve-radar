import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "san-ve-archive-test-"));
process.env.DATA_DIR = tempRoot;
delete process.env.DATABASE_URL;
delete process.env.BACKUP_DATABASE_URL;

const { getArchiveHistory, getArchiveStatus, listArchiveRoutes, recordArchiveSearchResults, registerArchiveRoute } = await import("../archive-runner.mjs");
const { readArchive, writeArchive } = await import("../archive-store.mjs");

test("migrates legacy NRT-HAN targets without losing history", async () => {
  await writeArchive({
    version: 1,
    config: null,
    targets: [{ date: "2026-09-05", status: "available", scans: 1, lastScannedAt: "2026-08-28T00:00:00.000Z", availableProviders: ["VJ"] }],
    history: [{ id: "legacy-1", route: "NRT-HAN", date: "2026-09-05", provider: "VJ", airline: "VietJet Air", observedAt: "2026-08-28T00:00:00.000Z", cheapestAmount: 3000000, signature: "legacy", fares: [] }],
    runs: []
  });
  const status = await getArchiveStatus({ origin: "NRT", destination: "HAN" });
  const state = await readArchive();
  assert.equal(status.historyRecords, 1);
  assert.ok(state.targets.some((target) => target.route === "NRT-HAN" && target.origin === "NRT" && target.destination === "HAN"));
  assert.ok(state.history.some((item) => item.id === "legacy-1" && item.origin === "NRT" && item.destination === "HAN"));
});

test("registers and filters a domestic Vietnam route", async () => {
  const registered = await registerArchiveRoute({ origin: "sgn", destination: "dad", from: "2026-09-10", to: "2026-09-12", source: "search" });
  assert.equal(registered.route.id, "SGN-DAD");
  assert.equal(registered.addedDates, 3);

  const status = await getArchiveStatus({ origin: "SGN", destination: "DAD" });
  assert.equal(status.route, "SGN-DAD");
  assert.equal(status.totalDates, 3);
  assert.equal(status.pendingDates, 3);

  const routes = await listArchiveRoutes();
  assert.ok(routes.some((route) => route.id === "SGN-DAD"));
  assert.ok(routes.some((route) => route.id === "NRT-HAN"));
});

test("accepts Japan domestic and international IATA routes", async () => {
  await registerArchiveRoute({ origin: "HND", destination: "CTS", from: "2026-10-01", to: "2026-10-02", source: "follow" });
  await registerArchiveRoute({ origin: "CDG", destination: "HAN", from: "2026-11-01", to: "2026-11-01", source: "search" });
  const routes = await listArchiveRoutes();
  assert.ok(routes.some((route) => route.id === "HND-CTS"));
  assert.ok(routes.some((route) => route.id === "CDG-HAN"));
});

test("stores live search results immediately as route history", async () => {
  const archive = await recordArchiveSearchResults({
    origin: "KIX", destination: "FUK", from: "2026-10-10", to: "2026-10-10",
    days: [{ departureDate: "2026-10-10", results: [{ checkedAt: "2026-08-28T02:00:00.000Z", fares: [{ amount: 2500000, currency: "VND", provider: "NH", airline: "ANA", departureTime: "09:00", arrivalTime: "10:15", stops: 0 }] }] }]
  });
  const history = await getArchiveHistory({ origin: "KIX", destination: "FUK", from: "2026-10-10", to: "2026-10-10" });
  assert.equal(archive.recordedDates, 1);
  assert.equal(archive.changed, 1);
  assert.equal(history.length, 1);
  assert.equal(history[0].cheapestAmount, 2500000);
});

test.after(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});
