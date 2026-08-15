const providers = [{ code: "GF", name: "Các hãng khả dụng theo chặng", url: "https://www.google.com/travel/flights" }];

const officialSites = {
  VJ: "https://www.vietjetair.com/vi",
  VN: "https://www.vietnamairlines.com/vn/vi/home",
  JL: "https://www.jal.co.jp/jp/en/",
  NH: "https://www.ana.co.jp/en/jp/",
  KE: "https://www.koreanair.com/",
  OZ: "https://flyasiana.com/",
  SQ: "https://www.singaporeair.com/",
  TG: "https://www.thaiairways.com/",
  CX: "https://www.cathaypacific.com/",
  BR: "https://www.evaair.com/",
  CI: "https://www.china-airlines.com/",
  PR: "https://www.philippineairlines.com/",
  AK: "https://www.airasia.com/",
  FD: "https://www.airasia.com/",
  QH: "https://www.bambooairways.com/",
  VU: "https://www.vietravelairlines.vn/",
  TR: "https://www.flyscoot.com/",
  TW: "https://www.twayair.com/",
  "7C": "https://www.jejuair.net/",
  UA: "https://www.united.com/",
  DL: "https://www.delta.com/",
  AA: "https://www.aa.com/",
  BA: "https://www.britishairways.com/",
  AF: "https://www.airfrance.com/",
  LH: "https://www.lufthansa.com/"
};

const buildRouteLink = (airlineCode, itinerary, googleFlightsUrl) => {
  if (airlineCode === "VJ") {
    const params = new URLSearchParams({
      departAirport: itinerary.origin,
      arrivalAirport: itinerary.destination,
      departDate: itinerary.departureDate,
      tripType: "oneway",
      adultCount: "1",
      currency: "VND",
      languageCode: "vi"
    });
    return `https://www.vietjetair.com/vi?${params}`;
  }
  return googleFlightsUrl;
};

export function listProviders() { return providers; }

const directCache = new Map();
const directCacheTtlMs = 55 * 60 * 1000;

const googleFlightsTfs = (itinerary) => {
  const date = [...Buffer.from(itinerary.departureDate)];
  const origin = [...Buffer.from(itinerary.origin)];
  const destination = [...Buffer.from(itinerary.destination)];
  const search = Buffer.from([
    8, 28, 16, 2, 26, 30,
    18, 10, ...date,
    106, 7, 8, 1, 18, 3, ...origin,
    114, 7, 8, 1, 18, 3, ...destination,
    64, 1, 72, 1, 112, 1, 152, 1, 2
  ]);
  return search.toString("base64url");
};

export function parseGoogleFlightsHtml(html, itinerary, sourceUrl) {
  const fares = [];
  const labelPattern = /aria-label="([^"]*?đồng Việt Nam[^"]*?)"/g;
  for (const match of html.matchAll(labelPattern)) {
    const label = match[1].replaceAll("&amp;", "&");
    const amount = Number(label.match(/Từ\s+([\d.,]+)\s+đồng Việt Nam/i)?.[1]?.replace(/[.,]/g, ""));
    const airline = label.match(/của\s+(.+?)\.\s+Rời/i)?.[1]?.trim();
    const times = [...label.matchAll(/lúc\s+(\d{2}:\d{2})/gi)].map((item) => item[1]);
    if (!Number.isFinite(amount) || !airline || times.length < 2) continue;
    const nearby = html.slice(match.index, match.index + 5000);
    const provider = nearby.match(/airline_logos\/70px\/([A-Z0-9]{2,3})\.png/i)?.[1] || "GF";
    const stopsMatch = label.match(/(\d+)\s+điểm dừng/i);
    const stops = /bay thẳng/i.test(label) ? 0 : (stopsMatch ? Number(stopsMatch[1]) : 1);
    fares.push({
      amount,
      currency: "VND",
      fareDate: itinerary.departureDate,
      provider,
      airline,
      bookingUrl: sourceUrl,
      officialUrl: officialSites[provider] || null,
      flightNumber: null,
      departureTime: times[0],
      arrivalTime: times[1],
      stops,
      kind: "google-flights-direct"
    });
  }
  return fares
    .filter((fare, index, all) => all.findIndex((item) => item.amount === fare.amount && item.airline === fare.airline && item.departureTime === fare.departureTime && item.arrivalTime === fare.arrivalTime) === index)
    .sort((a, b) => a.amount - b.amount)
    .slice(0, 20);
}

async function scrapeGoogleFlightsDirect(itinerary) {
  const cacheKey = `${itinerary.origin}-${itinerary.destination}-${itinerary.departureDate}-VND`;
  const cached = directCache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < directCacheTtlMs) return { ...cached.value, cacheHit: true };
  const params = new URLSearchParams({ hl: "vi", gl: "vn", curr: "VND", tfs: googleFlightsTfs(itinerary) });
  const sourceUrl = `https://www.google.com/travel/flights?${params}`;
  const response = await fetch(sourceUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(60000),
    headers: {
      "accept-language": "vi-VN,vi;q=0.9,en;q=0.7",
      "user-agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36"
    }
  });
  if (!response.ok) throw new Error(`Google Flights returned HTTP ${response.status}`);
  const html = await response.text();
  const fares = parseGoogleFlightsHtml(html, itinerary, sourceUrl);
  const value = { provider: "GF", airline: "Google Flights", route: `${itinerary.origin}-${itinerary.destination}`, sourceUrl, fares, dataSource: "Google Flights public page", direct: true };
  if (fares.length) directCache.set(cacheKey, { savedAt: Date.now(), value });
  return value;
}

async function scrapeVietnamAirlines(itinerary) {
  if (itinerary.origin !== "NRT" || itinerary.destination !== "HAN") return null;
  const page = "https://www.vietnamairlines.com/en-jp/flights-from-tokyo-to-hanoi";
  const html = await (await fetch(page, { headers: { "user-agent": "SanVeRadar/0.1 (+price-monitor)" } })).text();
  const prices = [...html.matchAll(/data-test="price"[\s\S]{0,900}?From\s+([0-9,]+)円/gi)]
    .map((m) => Number(m[1].replaceAll(",", ""))).filter(Number.isFinite);
  const unique = [...new Set(prices)].sort((a, b) => a - b);
  return { provider: "VN", airline: "Vietnam Airlines", route: "NRT-HAN", sourceUrl: page, fares: unique.slice(0, 10).map((amount) => ({ amount, currency: "JPY", kind: "route-page-observation" })) };
}

async function scrapeFlightsViaSerpApi(itinerary) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return null;
  const params = new URLSearchParams({ engine: "google_flights", departure_id: itinerary.origin, arrival_id: itinerary.destination, outbound_date: itinerary.departureDate, type: "2", adults: "1", travel_class: "1", currency: "VND", hl: "vi", gl: "vn", sort_by: "2", api_key: apiKey });
  const response = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(60000) });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || `SerpApi returned HTTP ${response.status}`);
  const offers = [...(payload.best_flights || []), ...(payload.other_flights || [])];
  const googleFlightsUrl = payload.search_metadata?.google_flights_url || "https://www.google.com/travel/flights";
  const fares = offers.map((offer) => {
    const segments = offer.flights || [];
    const first = segments[0] || {};
    const last = segments.at(-1) || {};
    const flightNumber = first.flight_number || null;
    const airlineCode = flightNumber?.split(/\s+/)[0] || "GF";
    return { amount: Number(offer.price), currency: "VND", fareDate: itinerary.departureDate, provider: airlineCode, airline: first.airline || "Hãng bay", bookingUrl: buildRouteLink(airlineCode, itinerary, googleFlightsUrl), officialUrl: officialSites[airlineCode] || null, flightNumber, departureTime: first.departure_airport?.time?.slice(11, 16) || null, arrivalTime: last.arrival_airport?.time?.slice(11, 16) || null, stops: Math.max(0, segments.length - 1), kind: "google-flights-live" };
  }).filter((fare) => Number.isFinite(fare.amount));
  const unique = fares.filter((fare, index, all) => all.findIndex((item) => item.amount === fare.amount && item.flightNumber === fare.flightNumber) === index).sort((a, b) => a.amount - b.amount);
  return { provider: "GF", airline: "Google Flights", route: `${itinerary.origin}-${itinerary.destination}`, sourceUrl: payload.search_metadata?.google_flights_url || "https://www.google.com/travel/flights", fares: unique.slice(0, 20), dataSource: "SerpApi Google Flights" };
}

async function scrapeVietJet(itinerary) {
  if (itinerary.origin !== "NRT" || itinerary.destination !== "HAN") return null;
  const params = new URLSearchParams({ departAirport: itinerary.origin, arrivalAirport: itinerary.destination, departDate: itinerary.departureDate, returnDate: "", tripType: "oneway", adultCount: "1", currency: "JPY", languageCode: "en" });
  const page = `https://www.vietjetair.com/?${params}`;
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const pageView = await browser.newPage({ locale: "en-US", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", viewport: { width: 1440, height: 1000 } });
  try {
    await pageView.route("**/*", (route) => ["image", "font", "media"].includes(route.request().resourceType()) ? route.abort() : route.continue());
    await pageView.goto(page, { waitUntil: "commit", timeout: 45000 });
    await pageView.waitForFunction(() => {
      const bodyText = document.body?.innerText || "";
      return /\bVJ\d+\b/.test(bodyText) || bodyText.includes("No flights");
    }, null, { timeout: 45000 }).catch(() => {});
    const text = await pageView.locator("body").innerText();
    const fares = [];
    const flightPattern = /(?:^|\n)(VJ\d+)\n([^\n]*\d{2}:\d{2}\s+To\s+\d{2}:\d{2})([\s\S]*?)(?=\nVJ\d+\n|\nOperated by\n|\nTotal\n)/g;
    for (const match of text.matchAll(flightPattern)) {
      const prices = [...match[3].matchAll(/(\d{1,3}(?:\.\d{3})*)\s*(\.\d{2})?\s*JPY/g)]
        .map((price) => Number(price[1].replaceAll(".", "") + (price[2] || ""))).filter(Number.isFinite);
      if (!prices.length) continue;
      const [departureTime, arrivalTime] = match[2].match(/\d{2}:\d{2}/g) || [];
      fares.push({ amount: Math.min(...prices), currency: "JPY", fareDate: itinerary.departureDate, flightNumber: match[1], departureTime, arrivalTime, stops: 0, kind: "live-search" });
    }
    const unique = fares.filter((f, i, a) => a.findIndex((x) => x.flightNumber === f.flightNumber && x.fareDate === f.fareDate) === i).sort((a, b) => a.amount - b.amount);
    return { provider: "VJ", airline: "VietJet Air", route: "NRT-HAN", sourceUrl: pageView.url(), fares: unique.slice(0, 10), ...(unique.length ? {} : { diagnostic: { title: await pageView.title(), bodyLength: text.length, hasFlightResults: /\bVJ\d+\b/.test(text) } }) };
  } finally { await browser.close(); }
}

export async function scrapeProvider(provider, itinerary) {
  // Each airline has a different search form and anti-bot policy. This adapter
  // is intentionally isolated so selectors can be updated without touching the API.
  const now = new Date().toISOString();
  if (provider.code === "VN") {
    try {
      const vn = await scrapeVietnamAirlines(itinerary);
      if (vn) return { ...vn, departureDate: itinerary.departureDate, checkedAt: now, status: vn.fares.length ? "ok" : "no_fare_found" };
    } catch (error) {
      return { provider: "VN", airline: "Vietnam Airlines", route: `${itinerary.origin}-${itinerary.destination}`, departureDate: itinerary.departureDate, checkedAt: now, status: "error", message: error.message, fares: [] };
    }
  }
  if (provider.code === "GF") {
    let directError = null;
    try {
      const direct = await scrapeGoogleFlightsDirect(itinerary);
      if (direct.fares.length) return { ...direct, departureDate: itinerary.departureDate, checkedAt: now, status: "ok" };
    } catch (error) {
      directError = error;
    }
    try {
      const serp = await scrapeFlightsViaSerpApi(itinerary);
      if (serp) return { ...serp, departureDate: itinerary.departureDate, checkedAt: now, status: serp.fares.length ? "ok" : "no_fare_found", fallbackUsed: true };
      return { provider: "GF", airline: "Các hãng khả dụng", route: `${itinerary.origin}-${itinerary.destination}`, departureDate: itinerary.departureDate, checkedAt: now, status: "source_unavailable", message: directError?.message || "No direct fares were found and SERPAPI_KEY is not configured.", fares: [] };
    } catch (error) {
      return { provider: "GF", airline: "Các hãng khả dụng", route: `${itinerary.origin}-${itinerary.destination}`, departureDate: itinerary.departureDate, checkedAt: now, status: "error", message: `${directError?.message || "Direct Google Flights parsing returned no fares"}; fallback: ${error.message}`, fares: [] };
    }
  }
  return {
    provider: provider.code,
    airline: provider.name,
    route: `${itinerary.origin}-${itinerary.destination}`,
    departureDate: itinerary.departureDate,
    checkedAt: now,
    status: "adapter_pending",
    message: "Provider adapter requires a verified public fare page and selectors.",
    fares: [],
  };
}
