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

async function scrapeVietJet(itinerary) {
  if (itinerary.origin !== "NRT" || itinerary.destination !== "HAN") return null;
  const page = "https://www.vietjetair.com/en/flight-tickets/flights-from-tokyo-narita-to-ha-noi";
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const pageView = await browser.newPage({ locale: "en-US" });
  try {
    await pageView.route("**/*", (route) => ["image", "font", "media"].includes(route.request().resourceType()) ? route.abort() : route.continue());
    await pageView.goto(page, { waitUntil: "commit", timeout: 45000 });
    await pageView.waitForTimeout(12000);
    const text = await pageView.locator("body").innerText();
    const fares = [...text.matchAll(/(?:Price\s+from|From)\s*([0-9]+(?:[.,][0-9]+)?)\s*(EUR|USD)/gi)].map((m) => ({ amount: Number(m[1].replace(",", ".")), currency: m[2].toUpperCase(), kind: "route-page-observation" }));
    const unique = fares.filter((f, i, a) => a.findIndex((x) => x.amount === f.amount && x.currency === f.currency) === i).sort((a, b) => a.amount - b.amount);
    return { provider: "VJ", airline: "VietJet Air", route: "NRT-HAN", sourceUrl: page, fares: unique.slice(0, 10) };
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
      const vj = await scrapeVietJet(itinerary);
      if (vj) return { ...vj, departureDate: itinerary.departureDate, checkedAt: now, status: vj.fares.length ? "ok" : "no_fare_found" };
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
