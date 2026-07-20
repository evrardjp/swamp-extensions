import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  brokerCommand,
  isBrokerProcess,
  isTraderPriceInWindow,
  model,
} from "./guildwars_kamadan.ts";

Deno.test("guildwars-kamadan exposes ingestion and aggregation methods", () => {
  assertEquals(model.type, "@evrardjp/guildwars-kamadan");
  for (
    const method of [
      "captureLiveFeed",
      "drainLiveFeed",
      "syncItemCatalog",
      "aggregateMarketValues",
    ]
  ) {
    assert(method in model.methods);
  }
});

Deno.test("guildwars-kamadan applies feed defaults", () => {
  const parsed = model.globalArguments.parse({});
  assertEquals(parsed.websocketUrl, "wss://kamadan.gwtoolbox.com/");
  assertEquals(parsed.maxDrainEvents, 500);
  assertEquals(parsed.marketWindowHours, 24);
});

Deno.test("broker command passes hostile paths and URLs as literal arguments", () => {
  const command = brokerCommand(
    "/tmp/broker'; touch /tmp/injected; 'broker.ts",
    "wss://example.test/'; touch /tmp/injected; '",
    "/tmp/spool dir/$(touch injected)",
  );

  assertEquals(command.command, "deno");
  assertEquals(command.args.slice(-3), [
    "/tmp/broker'; touch /tmp/injected; 'broker.ts",
    "wss://example.test/'; touch /tmp/injected; '",
    "/tmp/spool dir/$(touch injected)",
  ]);
});

Deno.test("broker PID ownership requires the exact generated command", async () => {
  const command = brokerCommand(
    "/repo/.swamp/kamadan-broker/broker.ts",
    "wss://kamadan.gwtoolbox.com/",
    "/repo/.swamp/kamadan-broker",
  );
  let readPath = "";
  const readFile = (path: string) => {
    readPath = path;
    return Promise.resolve(
      new TextEncoder().encode(
        ["/usr/bin/deno", ...command.args, ""].join("\0"),
      ),
    );
  };

  assertEquals(await isBrokerProcess(123, command, readFile), true);
  assertEquals(readPath, "/proc/123/cmdline");
});

Deno.test("broker PID ownership rejects stale or unreadable processes", async () => {
  const command = brokerCommand(
    "/repo/.swamp/kamadan-broker/broker.ts",
    "wss://kamadan.gwtoolbox.com/",
    "/repo/.swamp/kamadan-broker",
  );
  const commandLine = (argv: string[]) =>
    Promise.resolve(new TextEncoder().encode([...argv, ""].join("\0")));

  assertEquals(
    await isBrokerProcess(
      456,
      command,
      () => commandLine(["/usr/bin/sleep", "60"]),
    ),
    false,
  );
  assertEquals(
    await isBrokerProcess(
      456,
      command,
      () =>
        commandLine([
          "/usr/bin/deno",
          ...brokerCommand(
            "/tmp/unrelated-broker.ts",
            "wss://kamadan.gwtoolbox.com/",
            "/repo/.swamp/kamadan-broker",
          ).args,
        ]),
    ),
    false,
  );
  assertEquals(
    await isBrokerProcess(
      456,
      command,
      () => Promise.reject(new Error("gone")),
    ),
    false,
  );
});

Deno.test("market cutoff excludes stale direct trader prices", () => {
  assertEquals(isTraderPriceInWindow({ sourceTimestamp: 999 }, 1000), false);
  assertEquals(isTraderPriceInWindow({ sourceTimestamp: 1000 }, 1000), true);
});

Deno.test("catalog page cap reports truncation", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  let written: Record<string, unknown> | undefined;
  globalThis.fetch = () => {
    fetches++;
    return Promise.resolve(Response.json({
      query: { categorymembers: [{ title: "Item one" }] },
      continue: { cmcontinue: "next-page" },
    }));
  };
  try {
    const globalArgs = model.globalArguments.parse({});
    await model.methods.syncItemCatalog.execute(
      { maxCategories: 200, maxPagesPerCategory: 1 },
      {
        globalArgs,
        writeResource: (_specName, _name, data) => {
          written = data;
          return Promise.resolve({ name: "itemCatalog-current" });
        },
      } as Parameters<typeof model.methods.syncItemCatalog.execute>[1],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertEquals(fetches, 1);
  assertEquals(written?.truncated, true);
});
