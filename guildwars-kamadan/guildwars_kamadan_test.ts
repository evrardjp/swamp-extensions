import { assert, assertEquals } from "jsr:@std/assert@1";
import { model } from "./guildwars_kamadan.ts";

Deno.test("guildwars-kamadan exposes ingestion and aggregation methods", () => {
  assertEquals(model.type, "@evrardjp/guildwars-kamadan");
  for (const method of ["captureLiveFeed", "drainLiveFeed", "syncItemCatalog", "aggregateMarketValues"]) {
    assert(method in model.methods);
  }
});

Deno.test("guildwars-kamadan applies feed defaults", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.websocketUrl, "wss://kamadan.gwtoolbox.com/");
  assertEquals(parsed.maxDrainEvents, 500);
  assertEquals(parsed.marketWindowHours, 24);
});
