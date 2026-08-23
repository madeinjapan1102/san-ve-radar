import http from "node:http";
import crypto from "node:crypto";
import { readStore, writeStore } from "./store-file.mjs";
import { listProviders, scrapeProvider } from "./scrapers.mjs";
import { getArchiveCalendar, getArchiveHistory, getArchiveStatus, runArchiveBatch } from "./archive-runner.mjs";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";

const port = Number(process.env.PORT || 10000);
const json = (res, status, body) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,accept",
    "access-control-max-age": "86400"
  });
  res.end(JSON.stringify(body));
};
const body = async (req) => { let raw = ""; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : {}; };
const datesBetween = (start, end = start, limit = 14) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new Error("invalid_date_format");
  const from = new Date(`${start}T00:00:00Z`), to = new Date(`${end}T00:00:00Z`);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) throw new Error("invalid_date_range");
  const result = [];
  for (let date = from; date <= to; date = new Date(date.getTime() + 86400000)) {
    if (result.length >= limit) throw new Error(`date_range_exceeds_${limit}_days`);
    result.push(date.toISOString().slice(0, 10));
  }
  return result;
};
const searchDate = async (origin, destination, departureDate) => {
  const itinerary = { origin, destination, departureDate };
  const results = [];
  for (const provider of listProviders()) results.push(await scrapeProvider(provider, itinerary));
  return { departureDate, results };
};
const getFirebaseApp = () => {
  if (getApps().length) return getApps()[0];
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  return initializeApp({ credential: cert(JSON.parse(raw)) });
};
const sendPush = async (store, notification) => {
  const app = getFirebaseApp();
  const tokens = [...new Set((store.devices || []).filter((item) => item.enabled !== false).map((item) => item.token).filter(Boolean))];
  if (!app || !tokens.length) return { sent: 0, skipped: true };
  const amount = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(notification.amount);
  const title = `Vé ${notification.route} đã xuống dưới ngưỡng`;
  const messageBody = `${notification.airline} ${notification.flightNumber || ""} lúc ${notification.departureTime || "--:--"}: ${amount}`;
  const response = await getMessaging(app).sendEachForMulticast({ tokens, data: { title, body: messageBody, itineraryId: notification.itineraryId, notificationId: notification.id } });
  return { sent: response.successCount, failed: response.failureCount };
};
const addFareNotification = (store, itinerary, quote) => {
  if (quote.status !== "ok" || !Array.isArray(quote.fares) || !quote.fares.length) return null;
  const currency = quote.fares[0].currency;
  const threshold = currency === "JPY" ? Number(itinerary.thresholdJpy) : currency === "VND" ? Number(itinerary.thresholdVnd) : (itinerary.thresholdCurrency === currency ? Number(itinerary.threshold) : NaN);
  if (!Number.isFinite(threshold) || threshold <= 0) return null;
  const eligible = quote.fares.filter((fare) => fare.currency === currency && Number(fare.amount) <= threshold).sort((a, b) => a.amount - b.amount);
  if (!eligible.length) return null;
  const fare = eligible[0];
  const fareProvider = fare.provider || quote.provider;
  const duplicate = store.notifications.some((item) => item.itineraryId === itinerary.id && item.provider === fareProvider && item.fareDate === fare.fareDate && item.amount === fare.amount);
  if (duplicate) return null;
  const notification = { id: crypto.randomUUID(), itineraryId: itinerary.id, provider: fare.provider || quote.provider, airline: fare.airline || quote.airline, route: quote.route, fareDate: fare.fareDate, flightNumber: fare.flightNumber || null, departureTime: fare.departureTime || null, amount: fare.amount, currency: fare.currency, threshold, sourceUrl: quote.sourceUrl, read: false, createdAt: new Date().toISOString() };
  store.notifications.unshift(notification);
  return notification;
};

let archiveRunPromise = null;

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, service: "san-ve-radar-api", time: new Date().toISOString() });
    if (req.method === "GET" && url.pathname === "/archive/status") return json(res, 200, await getArchiveStatus());
    if (req.method === "GET" && url.pathname === "/archive/calendar") {
      const from = url.searchParams.get("from") || undefined;
      const to = url.searchParams.get("to") || undefined;
      return json(res, 200, { route: "NRT-HAN", prices: await getArchiveCalendar(from, to) });
    }
    if (req.method === "GET" && url.pathname === "/archive/history") {
      const date = url.searchParams.get("date") || undefined;
      const provider = url.searchParams.get("provider")?.toUpperCase() || undefined;
      if (provider && !["VJ", "VN", "NH", "JL"].includes(provider)) return json(res, 400, { error: "unsupported_provider" });
      return json(res, 200, { route: "NRT-HAN", date, provider, changes: await getArchiveHistory(date, provider) });
    }
    if (req.method === "POST" && url.pathname === "/archive/run") {
      if (archiveRunPromise) return json(res, 409, { error: "archive_scan_already_running" });
      const input = await body(req);
      archiveRunPromise = runArchiveBatch(input.limit || 12);
      try { return json(res, 200, await archiveRunPromise); }
      finally { archiveRunPromise = null; }
    }
    if (req.method === "GET" && url.pathname === "/providers") return json(res, 200, { providers: listProviders() });
    if (req.method === "GET" && url.pathname === "/itineraries") return json(res, 200, { itineraries: (await readStore()).itineraries });
    if (req.method === "POST" && url.pathname === "/itineraries") {
      const input = await body(req);
      if (!input.origin || !input.destination || !input.departureDate) return json(res, 400, { error: "origin, destination and departureDate are required" });
      const store = await readStore();
      const item = { id: crypto.randomUUID(), ...input, enabled: true, createdAt: new Date().toISOString() };
      store.itineraries.push(item); await writeStore(store); return json(res, 201, item);
    }
    const itineraryMatch = url.pathname.match(/^\/itineraries\/([^/]+)$/);
    if (itineraryMatch && req.method === "PATCH") {
      const input = await body(req); const store = await readStore();
      const item = store.itineraries.find((entry) => entry.id === itineraryMatch[1]);
      if (!item) return json(res, 404, { error: "itinerary_not_found" });
      if (input.thresholdJpy !== undefined) item.thresholdJpy = Number(input.thresholdJpy);
      if (input.thresholdVnd !== undefined) item.thresholdVnd = Number(input.thresholdVnd);
      if (input.enabled !== undefined) item.enabled = Boolean(input.enabled);
      item.updatedAt = new Date().toISOString(); await writeStore(store); return json(res, 200, item);
    }
    if (itineraryMatch && req.method === "DELETE") {
      const store = await readStore(); const before = store.itineraries.length;
      store.itineraries = store.itineraries.filter((entry) => entry.id !== itineraryMatch[1]);
      if (store.itineraries.length === before) return json(res, 404, { error: "itinerary_not_found" });
      await writeStore(store); return json(res, 200, { deleted: true });
    }
    if (req.method === "GET" && url.pathname === "/quotes") return json(res, 200, { quotes: (await readStore()).quotes });
    if (req.method === "GET" && url.pathname === "/devices") return json(res, 200, { count: ((await readStore()).devices || []).length });
    if (req.method === "POST" && url.pathname === "/devices") {
      const input = await body(req); if (!input.token) return json(res, 400, { error: "token_required" });
      const store = await readStore(); store.devices ||= [];
      const existing = store.devices.find((item) => item.token === input.token);
      if (existing) { existing.enabled = true; existing.updatedAt = new Date().toISOString(); }
      else store.devices.push({ id: crypto.randomUUID(), token: input.token, platform: input.platform || "android", enabled: true, createdAt: new Date().toISOString() });
      await writeStore(store); return json(res, 200, { registered: true });
    }
    if (req.method === "POST" && url.pathname === "/search") {
      const input = await body(req);
      if (!input.origin || !input.destination || !input.departureDate) return json(res, 400, { error: "origin, destination and departureDate are required" });
      const maxStops = input.maxStops === 0 ? 0 : input.maxStops === 1 ? 1 : null;
      const itinerary = { origin: String(input.origin).toUpperCase(), destination: String(input.destination).toUpperCase(), departureDate: input.departureDate, endDate: input.endDate || input.departureDate, maxStops };
      let dates;
      try { dates = datesBetween(itinerary.departureDate, itinerary.endDate); }
      catch (error) { return json(res, 400, { error: error.message, message: "Khoảng theo dõi phải hợp lệ và không quá 14 ngày." }); }
      const days = [];
      for (let index = 0; index < dates.length; index += 3) {
        days.push(...await Promise.all(dates.slice(index, index + 3).map((date) => searchDate(itinerary.origin, itinerary.destination, date))));
      }
      if (maxStops !== null) for (const day of days) for (const result of day.results) {
        result.fares = (result.fares || []).filter((fare) => Number(fare.stops || 0) <= maxStops);
        if (result.status === "ok" && !result.fares.length) result.status = "no_fare_found";
      }
      return json(res, 200, { searchedAt: new Date().toISOString(), itinerary, days, results: days.length === 1 ? days[0].results : [] });
    }
    if ((req.method === "POST" || req.method === "GET") && url.pathname === "/check") {
      const input = req.method === "POST" ? await body(req) : {}; const store = await readStore();
      const targets = store.itineraries.filter((item) => item.enabled !== false && (!input.itineraryId || item.id === input.itineraryId));
      const results = []; const notificationsBefore = store.notifications.length; const pushes = [];
      for (const itinerary of targets) for (const provider of listProviders()) {
        const quote = await scrapeProvider(provider, itinerary);
        store.quotes.push({ itineraryId: itinerary.id, ...quote });
        const created = addFareNotification(store, itinerary, quote);
        if (created) pushes.push(await sendPush(store, created).catch((error) => ({ sent: 0, error: error.message })));
        results.push({ itineraryId: itinerary.id, ...quote });
      }
      await writeStore(store); return json(res, 200, { checkedAt: new Date().toISOString(), notificationsCreated: store.notifications.length - notificationsBefore, pushes, results });
    }
    if (req.method === "GET" && url.pathname === "/notifications") return json(res, 200, { notifications: (await readStore()).notifications });
    return json(res, 404, { error: "not_found" });
  } catch (error) { return json(res, 500, { error: "server_error", message: error.message }); }
});

server.listen(port, () => console.log(`San Ve Radar API listening on ${port}`));
