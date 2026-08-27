import crypto from "node:crypto";
import { readArchive, writeArchive, archiveStorageKind, archiveStorageStatus } from "./archive-store.mjs";
import { listProviders, scrapeProvider } from "./scrapers.mjs";

const scanIntervalMs = 8 * 60 * 60 * 1000;
const googleProvider = listProviders().find((item) => item.code === "GF");
const defaultRoute = { origin: "NRT", destination: "HAN" };

const isoDate = (date) => date.toISOString().slice(0, 10);
const todayTokyo = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (date, days) => isoDate(new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400000));
const configuredHorizon = () => {
  const rolling = addDays(todayTokyo(), 365);
  return [process.env.ARCHIVE_END_DATE || "2027-05-31", rolling].sort().at(-1);
};
const normalizeCode = (value) => String(value || "").trim().toUpperCase();
const routeId = (origin, destination) => `${normalizeCode(origin)}-${normalizeCode(destination)}`;
const validCode = (value) => /^[A-Z0-9]{3}$/.test(normalizeCode(value));
const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && Number.isFinite(new Date(`${value}T00:00:00Z`).getTime());
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

function migrateState(input) {
  const state = { version: 2, config: null, routes: [], targets: [], history: [], runs: [], ...(input || {}) };
  state.routes ||= [];
  state.targets ||= [];
  state.history ||= [];
  state.runs ||= [];
  for (const target of state.targets) {
    target.origin ||= defaultRoute.origin;
    target.destination ||= defaultRoute.destination;
    target.route ||= routeId(target.origin, target.destination);
  }
  for (const item of state.history) {
    const [routeOrigin, routeDestination] = String(item.route || "NRT-HAN").split("-");
    item.origin ||= routeOrigin || defaultRoute.origin;
    item.destination ||= routeDestination || defaultRoute.destination;
    item.route = routeId(item.origin, item.destination);
  }
  const known = new Map(state.routes.map((route) => [route.id || routeId(route.origin, route.destination), route]));
  for (const target of state.targets) {
    if (!known.has(target.route)) known.set(target.route, { id: target.route, origin: target.origin, destination: target.destination, source: target.route === "NRT-HAN" ? "legacy" : "archive", active: true, firstSeenAt: new Date().toISOString(), lastRequestedAt: new Date().toISOString() });
  }
  state.routes = [...known.values()].map((route) => ({ active: true, ...route, id: route.id || routeId(route.origin, route.destination) }));
  state.version = 2;
  return state;
}

function addTargets(state, route, from, to) {
  const existing = new Map(state.targets.map((target) => [`${target.route}:${target.date}`, target]));
  for (const date of datesBetween(from, to)) {
    const key = `${route.id}:${date}`;
    if (!existing.has(key)) {
      const target = { route: route.id, origin: route.origin, destination: route.destination, date, status: "pending", scans: 0, lastScannedAt: null, nextDueAt: null, availableProviders: [] };
      state.targets.push(target);
      existing.set(key, target);
    }
  }
}

function cleanupExpired(state) {
  const today = todayTokyo();
  state.targets = state.targets.filter((target) => target.date >= today);
  state.history = state.history.filter((item) => item.date >= today);
  const usedRoutes = new Set(state.targets.map((target) => target.route));
  state.routes = state.routes.filter((route) => route.id === "NRT-HAN" || usedRoutes.has(route.id));
}

export async function ensureArchiveTargets() {
  const state = migrateState(await readArchive());
  cleanupExpired(state);
  const today = todayTokyo();
  const configuredStart = process.env.ARCHIVE_START_DATE || today;
  const startDate = configuredStart > today ? configuredStart : today;
  let route = state.routes.find((item) => item.id === "NRT-HAN");
  if (!route) {
    route = { id: "NRT-HAN", ...defaultRoute, source: "default", active: true, firstSeenAt: new Date().toISOString(), lastRequestedAt: new Date().toISOString() };
    state.routes.push(route);
  }
  addTargets(state, route, startDate, configuredHorizon());
  state.config = {
    mode: "multi-route-on-demand",
    defaultRoute,
    coverage: ["Vietnam ↔ international", "Vietnam domestic", "Japan domestic", "any valid IATA route requested by a user"],
    scansPerDay: 3,
    historyChanges: "all_until_departure",
    deleteRule: "delete_after_flight_date",
    rollingHorizonDays: 365,
    updatedAt: new Date().toISOString()
  };
  await writeArchive(state);
  return state;
}

export async function registerArchiveRoute({ origin, destination, from, to, source = "search" }) {
  origin = normalizeCode(origin);
  destination = normalizeCode(destination);
  const today = todayTokyo();
  from = from || today;
  to = to || from;
  if (!validCode(origin) || !validCode(destination) || origin === destination) throw new Error("invalid_route");
  if (!validDate(from) || !validDate(to) || from > to) throw new Error("invalid_date_range");
  if (to < today) throw new Error("flight_date_has_passed");
  const safeFrom = from < today ? today : from;
  if (datesBetween(safeFrom, to).length > 370) throw new Error("archive_range_exceeds_370_days");
  const state = migrateState(await readArchive());
  cleanupExpired(state);
  const id = routeId(origin, destination);
  let route = state.routes.find((item) => item.id === id);
  if (!route) {
    route = { id, origin, destination, source, active: true, firstSeenAt: new Date().toISOString(), lastRequestedAt: new Date().toISOString() };
    state.routes.push(route);
  } else {
    route.active = true;
    route.lastRequestedAt = new Date().toISOString();
    route.source = route.source === "follow" ? "follow" : source;
  }
  addTargets(state, route, safeFrom, to);
  await writeArchive(state);
  return { route, addedDates: state.targets.filter((target) => target.route === id && target.date >= safeFrom && target.date <= to).length };
}

function recordCarrierHistory(state, target, checkedAt, fares, provider) {
  const selected = fares.filter((fare) => fare.provider === provider).sort((a, b) => a.amount - b.amount).slice(0, 12).map(compactFare);
  if (!selected.length) return false;
  const sig = signature(selected);
  const previous = state.history.find((item) => item.route === target.route && item.date === target.date && item.provider === provider);
  if (previous?.signature === sig) return false;
  state.history.unshift({ id: crypto.randomUUID(), route: target.route, origin: target.origin, destination: target.destination, date: target.date, provider, airline: selected[0].airline || provider, observedAt: checkedAt, cheapestAmount: selected[0].amount, signature: sig, fares: selected });
  return true;
}

export async function recordArchiveSearchResults({ origin, destination, from, to, days, source = "search" }) {
  const registration = await registerArchiveRoute({ origin, destination, from, to, source });
  const state = migrateState(await readArchive());
  let changed = 0, recordedDates = 0;
  for (const day of days || []) {
    const target = state.targets.find((item) => item.route === registration.route.id && item.date === day.departureDate);
    if (!target) continue;
    const results = day.results || [];
    const checkedAt = results.find((item) => item.checkedAt)?.checkedAt || new Date().toISOString();
    const fares = results.flatMap((result) => result.fares || []).filter((fare) => fare.currency === "VND" && /^[A-Z0-9]{2,3}$/.test(String(fare.provider || "")));
    const available = [...new Set(fares.map((fare) => fare.provider))];
    for (const provider of available) if (recordCarrierHistory(state, target, checkedAt, fares, provider)) changed += 1;
    target.lastScannedAt = checkedAt;
    target.nextDueAt = new Date(new Date(checkedAt).getTime() + scanIntervalMs).toISOString();
    target.scans = Number(target.scans || 0) + 1;
    target.status = available.length ? "available" : "checked-empty";
    target.availableProviders = available;
    recordedDates += 1;
  }
  await writeArchive(state);
  return { ...registration, recordedDates, changed };
}

async function scanOne(target) {
  const itinerary = { origin: target.origin, destination: target.destination, departureDate: target.date };
  const result = await scrapeProvider(googleProvider, itinerary);
  return { target, result };
}

export async function runArchiveBatch(requestedLimit = 12) {
  const state = await ensureArchiveTargets();
  const now = new Date();
  const previousRun = state.runs[0];
  if (previousRun?.finishedAt && now.getTime() - new Date(previousRun.finishedAt).getTime() < 15 * 60 * 1000) {
    return { run: { skipped: true, reason: "minimum_15_minute_gap", previousRun: previousRun.id }, status: archiveStatus(state) };
  }
  const limit = Math.max(1, Math.min(12, Number(requestedLimit) || 12));
  const due = state.targets
    .filter((target) => !target.nextDueAt || new Date(target.nextDueAt) <= now)
    .sort((a, b) => String(a.lastScannedAt || "").localeCompare(String(b.lastScannedAt || "")) || a.date.localeCompare(b.date))
    .slice(0, limit);
  const run = { id: crypto.randomUUID(), startedAt: now.toISOString(), requested: due.length, scanned: 0, changed: 0, routes: [], errors: [] };
  for (let index = 0; index < due.length; index += 3) {
    const group = await Promise.allSettled(due.slice(index, index + 3).map(scanOne));
    for (const outcome of group) {
      if (outcome.status === "rejected") { run.errors.push(outcome.reason?.message || "scan_failed"); continue; }
      const { target, result } = outcome.value;
      const checkedAt = result.checkedAt || new Date().toISOString();
      const fares = (result.fares || []).filter((fare) => fare.currency === "VND" && /^[A-Z0-9]{2,3}$/.test(String(fare.provider || "")));
      const available = [...new Set(fares.map((fare) => fare.provider))];
      for (const provider of available) if (recordCarrierHistory(state, target, checkedAt, fares, provider)) run.changed += 1;
      target.lastScannedAt = checkedAt;
      target.nextDueAt = new Date(new Date(checkedAt).getTime() + scanIntervalMs).toISOString();
      target.scans = Number(target.scans || 0) + 1;
      target.status = result.status === "error" ? "error" : (available.length ? "available" : "checked-empty");
      target.availableProviders = available;
      target.lastError = result.status === "error" ? result.message : null;
      run.scanned += 1;
      if (!run.routes.includes(target.route)) run.routes.push(target.route);
    }
  }
  run.finishedAt = new Date().toISOString();
  run.storage = archiveStorageKind();
  state.runs.unshift(run);
  state.runs = state.runs.slice(0, 100);
  await writeArchive(state);
  return { run, status: archiveStatus(state) };
}

export function archiveStatus(state, route) {
  const targets = route ? state.targets.filter((item) => item.route === route) : state.targets;
  const history = route ? state.history.filter((item) => item.route === route) : state.history;
  return {
    config: state.config,
    storage: archiveStorageKind(),
    storageStatus: archiveStorageStatus(),
    route: route || null,
    totalRoutes: state.routes.length,
    routes: state.routes.map((item) => ({ id: item.id, origin: item.origin, destination: item.destination, source: item.source, active: item.active !== false })),
    totalDates: targets.length,
    scannedDates: targets.filter((item) => item.lastScannedAt).length,
    datesWithFares: targets.filter((item) => item.availableProviders?.length).length,
    pendingDates: targets.filter((item) => !item.lastScannedAt).length,
    historyRecords: history.length,
    latestRun: state.runs[0] || null
  };
}

export async function getArchiveStatus({ origin, destination } = {}) {
  const state = await ensureArchiveTargets();
  const route = origin && destination ? routeId(origin, destination) : null;
  return archiveStatus(state, route);
}

export async function listArchiveRoutes() {
  const state = await ensureArchiveTargets();
  return state.routes.map((route) => {
    const targets = state.targets.filter((target) => target.route === route.id);
    return { ...route, dates: targets.length, scannedDates: targets.filter((target) => target.lastScannedAt).length, historyRecords: state.history.filter((item) => item.route === route.id).length };
  });
}

export async function getArchiveCalendar({ origin = "NRT", destination = "HAN", from, to } = {}) {
  const state = await readArchive();
  const wantedRoute = routeId(origin, destination);
  const latest = new Map();
  for (const item of state.history || []) {
    if (item.route !== wantedRoute || (from && item.date < from) || (to && item.date > to)) continue;
    const key = `${item.date}:${item.provider}`;
    if (!latest.has(key)) latest.set(key, item);
  }
  return [...latest.values()].sort((a, b) => a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider));
}

export async function getArchiveHistory({ origin = "NRT", destination = "HAN", date, from, to, provider, limit = 5000 } = {}) {
  const state = await readArchive();
  const wantedRoute = routeId(origin, destination);
  return (state.history || [])
    .filter((item) => item.route === wantedRoute && (!date || item.date === date) && (!from || item.date >= from) && (!to || item.date <= to) && (!provider || item.provider === provider))
    .slice(0, Math.max(1, Math.min(20000, Number(limit) || 5000)));
}
