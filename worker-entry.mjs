import { readStore, writeStore } from "./store-file.mjs";
import { listProviders, scrapeProvider } from "./scrapers.mjs";

const store = await readStore();
const enabled = store.itineraries.filter((item) => item.enabled !== false);
for (const itinerary of enabled) {
  for (const provider of listProviders()) {
    const quote = await scrapeProvider(provider, itinerary);
    store.quotes.push({ itineraryId: itinerary.id, ...quote });
  }
}
await writeStore(store);
console.log(`Checked ${enabled.length} itineraries across ${listProviders().length} providers`);
