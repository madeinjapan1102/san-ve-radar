import crypto from "node:crypto";
import { readArchive, writeArchive, archiveStorageKind } from "./archive-store.mjs";
import { listProviders, scrapeProvider } from "./scrapers.mjs";

const route = { origin: "NRT", destination: "HAN" };
const carrierCodes = ["VJ", "VN", "NH", "JL"];
const carrierNames = { VJ: "VietJet Air", VN: "Vietnam Airlines", NH: "ANA", JL: "Japan Airlines" };
const endDate = process.env.ARCHIVE_END_DATE || "2027-05-31";
const scanIntervalMs = 8 * 60 * 60 * 1000;
const googleProvider = listProviders().find((item) => item.code === "GF");

const isoDate = (date) => date.toISOString().slice(0, 10);
const todayTokyo = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const datesBetween = (from, to) => {
  const dates = [];
  for (let date = new Date(`${from}T00:00:00Z`); date <= new Date(`${to}T00:00:00Z`); date = new Date(date.getTime() + 86400000)) dates.push(isoDate(date));
  return dates;
};
const compactFare = (fare) => ({
  amount: Number(fare.amount), currency: fare.currency, provider: fare.provider,
  airline: fare.airline, flightNumber: fare.flightNumber || null,
  departureTime: fare.departureTime || null, arrivalTime: fare.arrivalTime || null,
  stops: Number(fare.stops || 0), bookingUrl: fare.bookingUrl || fare.officialUrl || null,
  logoUrl: fare.logoUrl || null
});
const signature = (fares) => JSON.stringify(fares.map((fare) => [fare.amount, fare.flightNumber, fare.departureTime, fare.arrivalTime, fare.stops]));

export async function ensureArchiveTargets() {
  const state = await readArchive();
  const configuredStart = process.env.ARCHIVE_START_DATE || todayTokyo();
  const startDate = configuredStart > todayTokyo() ? configuredStart : todayTokyo();
  const wanted = new Set(datesBetween(startDate, endDate));
  const existing = new Map(state.targets.map((target) => [target.date, target]));
  state.targets = [...wanted].map((date) => existing.get(date) || { date, status: "pending", scans: 0, lastScannedAt: null, nextDueAt: null, availableProviders: [] });
  state.history = state.history.filter((item) => item.date >= startDate);
  state.config = { route, carrierCodes, carrierNames, startDate, endDate, scansPerDay: 3, historyChanges: "all_until_departure", deleteRule: "delete_after_flight_date", updatedAt: new Date().toISOString() };
  await writeArchive(state);
  return state;
}

function recordCarrierHistory(state, date, checkedAt, fares, provider) {
  const selected = fares.filter((fare) => fare.provider === provider).sort((a, b) => a.amount - b.amount).slice(0, 12).map(compactFare);
  if (!selected.length) return false;
  const sig = signature(selected);
  const previous = state.history.find((item) => item.date === date && item.provider === provider);
  if (previous?.signature === sig) return false;
  state.history.unshift({ id: crypto.randomUUID(), route: "NRT-HAN", date, provider, airline: selected[0].airline || carrierNames[provider], observedAt: checkedAt, cheapestAmount: selected[0].amount, signature: sig, fares: selected });
  return true;
}

async function scanOne(target) {
  const itinerary = { ...route, departureDate: target.date };
  const result = await scrapeProvider(googleProvider, itinerary);
  return { target, result };
}

export async function runArchiveBatch(requestedLimit = 12) {
  const state = await ensureArchiveTargets();
  const now = new Date(), today = todayTokyo();
  const previousRun = state.runs[0];
  if (previousRun?.finishedAt && now.getTime() - new Date(previousRun.finishedAt).getTime() < 15 * 60 * 1000) {
    return { run: { skipped: true, reason: "minimum_15_minute_gap", previousRun: previousRun.id }, status: archiveStatus(state) };
  }
  for (const target of state.targets) if (target.date < today) target.status = "expired";
  const limit = Math.max(1, Math.min(12, Number(requestedLimit) || 12));
  const due = state.targets
    .filter((target) => target.status !== "expired" && (!target.nextDueAt || new Date(target.nextDueAt) <= now))
    .sort((a, b) => String(a.lastScannedAt || "").localeCompare(String(b.lastScannedAt || "")) || a.date.localeCompare(b.date))
    .slice(0, limit);
  const run = { id: crypto.randomUUID(), startedAt: now.toISOString(), requested: due.length, scanned: 0, changed: 0, errors: [] };
  for (let index = 0; index < due.length; index += 3) {
    const group = await Promise.allSettled(due.slice(index, index + 3).map(scanOne));
    for (const outcome of group) {
      if (outcome.status === "rejected") { run.errors.push(outcome.reason?.message || "scan_failed"); continue; }
      const { target, result } = outcome.value;
      const checkedAt = result.checkedAt || new Date().toISOString();
      const fares = (result.fares || []).filter((fare) => fare.currency === "VND" && carrierCodes.includes(fare.provider));
      const available = [...new Set(fares.map((fare) => fare.provider))];
      for (const provider of carrierCodes) if (recordCarrierHistory(state, target.date, checkedAt, fares, provider)) run.changed += 1;
      target.lastScannedAt = checkedAt;
      target.nextDueAt = new Date(new Date(checkedAt).getTime() + scanIntervalMs).toISOString();
      target.scans = Number(target.scans || 0) + 1;
      target.status = result.status === "error" ? "error" : (available.length ? "available" : "checked-empty");
      target.availableProviders = available;
      target.lastError = result.status === "error" ? result.message : null;
      run.scanned += 1;
    }
  }
  run.finishedAt = new Date().toISOString();
  run.storage = archiveStorageKind();
  state.runs.unshift(run);
  state.runs = state.runs.slice(0, 100);
  await writeArchive(state);
  return { run, status: archiveStatus(state) };
}

export function archiveStatus(state) {
  const active = state.targets.filter((item) => item.status !== "expired");
  return {
    config: state.config,
    storage: archiveStorageKind(),
    totalDates: state.targets.length,
    activeDates: active.length,
    scannedDates: active.filter((item) => item.lastScannedAt).length,
    datesWithFares: active.filter((item) => item.availableProviders?.length).length,
    pendingDates: active.filter((item) => !item.lastScannedAt).length,
    historyRecords: state.history.length,
    latestRun: state.runs[0] || null
  };
}

export async function getArchiveStatus() {
  const state = await ensureArchiveTargets();
  return archiveStatus(state);
}

export async function getArchiveCalendar(from, to) {
  const state = await readArchive();
  const latest = new Map();
  for (const item of state.history) {
    if ((from && item.date < from) || (to && item.date > to)) continue;
    const key = `${item.date}:${item.provider}`;
    if (!latest.has(key)) latest.set(key, item);
  }
  return [...latest.values()].sort((a, b) => a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider));
}

export async function getArchiveHistory({ date, from, to, provider, limit = 5000 } = {}) {
  const state = await readArchive();
  return state.history
    .filter((item) => (!date || item.date === date) && (!from || item.date >= from) && (!to || item.date <= to) && (!provider || item.provider === provider))
    .slice(0, Math.max(1, Math.min(20000, Number(limit) || 5000)));
}
