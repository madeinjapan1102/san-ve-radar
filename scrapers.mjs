const providers = [
  { code: "VJ", name: "VietJet Air", url: "https://www.vietjetair.com/" },
  { code: "VN", name: "Vietnam Airlines", url: "https://www.vietnamairlines.com/" },
  { code: "JL", name: "Japan Airlines", url: "https://www.jal.co.jp/" },
  { code: "NH", name: "ANA", url: "https://www.ana.co.jp/" },
  { code: "SQ", name: "Singapore Airlines", url: "https://www.singaporeair.com/" },
  { code: "TG", name: "Thai Airways", url: "https://www.thaiairways.com/" },
  { code: "CX", name: "Cathay Pacific", url: "https://www.cathaypacific.com/" },
  { code: "KE", name: "Korean Air", url: "https://www.koreanair.com/" },
  { code: "OZ", name: "Asiana Airlines", url: "https://flyasiana.com/" },
];

export function listProviders() { return providers; }

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
  const params = new URLSearchParams({ engine: "google_flights", departure_id: itinerary.origin, arrival_id: itinerary.destination, outbound_date: itinerary.departureDate, type: "2", adults: "1", travel_class: "1", currency: "JPY", hl: "en", gl: "jp", sort_by: "2", api_key: apiKey });
  const response = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(60000) });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error || `SerpApi returned HTTP ${response.status}`);
  const offers = [...(payload.best_flights || []), ...(payload.other_flights || [])];
  const fares = offers.map((offer) => {
    const segments = offer.flights || [];
    const first = segments[0] || {};
    const last = segments.at(-1) || {};
    const flightNumber = first.flight_number || null;
    return { amount: Number(offer.price), currency: "JPY", fareDate: itinerary.departureDate, provider: flightNumber?.split(/\s+/)[0] || "GF", airline: first.airline || "Hãng bay", flightNumber, departureTime: first.departure_airport?.time?.slice(11, 16) || null, arrivalTime: last.arrival_airport?.time?.slice(11, 16) || null, stops: Math.max(0, segments.length - 1), kind: "google-flights-live" };
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
  if (provider.code === "VJ") {
    try {
      const serp = await scrapeFlightsViaSerpApi(itinerary);
      if (serp) return { ...serp, departureDate: itinerary.departureDate, checkedAt: now, status: serp.fares.length ? "ok" : "no_fare_found" };
      const vj = await scrapeVietJet(itinerary);
      if (vj) {
        const sourceBlocked = vj.diagnostic?.bodyLength === 0;
        return { ...vj, departureDate: itinerary.departureDate, checkedAt: now, status: sourceBlocked ? "source_blocked" : (vj.fares.length ? "ok" : "no_fare_found"), ...(sourceBlocked ? { message: "VietJet returned an empty page to the Render server; no fare was inferred." } : {}) };
      }
    } catch (error) {
      return { provider: "VJ", airline: "VietJet Air", route: `${itinerary.origin}-${itinerary.destination}`, departureDate: itinerary.departureDate, checkedAt: now, status: "error", message: error.message, fares: [] };
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
