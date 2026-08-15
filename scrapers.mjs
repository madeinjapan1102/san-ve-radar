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

export async function scrapeProvider(provider, itinerary) {
  // Each airline has a different search form and anti-bot policy. This adapter
  // is intentionally isolated so selectors can be updated without touching the API.
  const now = new Date().toISOString();
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
