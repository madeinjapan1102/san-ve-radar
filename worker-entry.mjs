import { readStore, writeStore } from "./store-file.mjs";
import { listProviders, scrapeProvider } from "./scrapers.mjs";
import { runArchiveBatch } from "./archive-runner.mjs";

const archiveResult = await runArchiveBatch(12);
console.log(`Archived ${archiveResult.run.scanned} dates with ${archiveResult.run.changed} changed carrier prices`);

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
