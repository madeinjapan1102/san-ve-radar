import { readStore, writeStore } from "./store-file.mjs";
import { listProviders, scrapeProvider } from "./scrapers.mjs";
import { registerArchiveRoute, runArchiveBatch } from "./archive-runner.mjs";

const archiveResult = await runArchiveBatch(12);
console.log(archiveResult.run.skipped
  ? `Archive skipped: ${archiveResult.run.reason}`
  : `Archived ${archiveResult.run.scanned} route-dates across ${(archiveResult.run.routes || []).length} routes with ${archiveResult.run.changed} changed carrier prices`);

const store = await readStore();
const enabled = store.itineraries.filter((item) => item.enabled !== false);
for (const itinerary of enabled) {
  await registerArchiveRoute({ origin: itinerary.origin, destination: itinerary.destination, from: itinerary.departureDate, to: itinerary.endDate || itinerary.departureDate, source: "follow" });
  for (const provider of listProviders()) {
    const quote = await scrapeProvider(provider, itinerary);
    store.quotes.push({ itineraryId: itinerary.id, ...quote });
  }
}
await writeStore(store);
console.log(`Checked ${enabled.length} itineraries across ${listProviders().length} providers`);
