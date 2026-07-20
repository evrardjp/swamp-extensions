import { z } from "npm:zod@4";

// Deno globals are available in Swamp extension runtime.
// @ts-ignore Deno global
const DenoApi = Deno;
// @ts-ignore Deno global
const DenoCommand = Deno.Command;

const GlobalArgsSchema = z.object({
  websocketUrl: z.string().url().default("wss://kamadan.gwtoolbox.com/"),
  brokerDir: z.string().default(".swamp/kamadan-broker"),
  wikiApiUrl: z.string().url().default("https://wiki.guildwars.com/api.php"),
  maxDrainEvents: z.number().int().positive().default(500),
  marketWindowHours: z.number().int().positive().default(24),
});

const CursorSchema = z.object({
  offset: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

const BrokerStatusSchema = z.object({
  running: z.boolean(),
  pid: z.number().int().optional(),
  websocketUrl: z.string(),
  brokerDir: z.string(),
  spoolPath: z.string(),
  spoolBytes: z.number().int().nonnegative(),
  cursorOffset: z.number().int().nonnegative(),
  updatedAt: z.string(),
  lastStatus: z.record(z.string(), z.unknown()).optional(),
});

const RawEventSchema = z.object({
  id: z.string(),
  kind: z.enum(["trade", "traderPrices", "control", "unknown"]),
  receivedAt: z.string(),
  payload: z.unknown(),
});

const TradeMessageSchema = z.object({
  id: z.string(),
  sourceTimestampMs: z.number(),
  observedAt: z.string(),
  user: z.string(),
  message: z.string(),
  replacementOf: z.number().optional(),
});

const TradeListingSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  side: z.enum(["WTS", "WTB", "unknown"]),
  user: z.string(),
  itemNameRaw: z.string().optional(),
  matchedItemName: z.string().optional(),
  priceRaw: z.string().optional(),
  quantityRaw: z.string().optional(),
  message: z.string(),
  timestampMs: z.number(),
  parserVersion: z.string(),
  confidence: z.number(),
});

const TraderPriceSchema = z.object({
  id: z.string(),
  side: z.enum(["buy", "sell"]),
  modelKey: z.string(),
  priceRaw: z.union([z.string(), z.number()]),
  sourceTimestamp: z.number(),
  observedAt: z.string(),
});

const CatalogSchema = z.object({
  syncedAt: z.string(),
  source: z.string(),
  truncated: z.boolean().default(false),
  items: z.array(z.object({
    name: z.string(),
    normalizedName: z.string(),
    wikiUrl: z.string().optional(),
    categories: z.array(z.string()).default([]),
  })),
});

const LiveItemMetadataSchema = z.object({
  syncedAt: z.string(),
  source: z.string(),
  items: z.record(
    z.string(),
    z.object({
      id: z.string(),
      name: z.string(),
      group: z.string(),
    }),
  ),
});

type LiveItemMetadata = z.infer<typeof LiveItemMetadataSchema>;

const MarketHourlySchema = z.object({
  id: z.string(),
  hour: z.string(),
  itemName: z.string(),
  group: z.string().default("unknown"),
  wtsSamples: z.number().int().nonnegative(),
  wtbSamples: z.number().int().nonnegative(),
  latestWtsRaw: z.string().optional(),
  latestWtbRaw: z.string().optional(),
  directBuyRaw: z.union([z.string(), z.number()]).optional(),
  directSellRaw: z.union([z.string(), z.number()]).optional(),
  notes: z.array(z.string()).default([]),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
type Cursor = z.infer<typeof CursorSchema>;
type Catalog = z.infer<typeof CatalogSchema>;
type TradeListing = z.infer<typeof TradeListingSchema>;
type TraderPrice = z.infer<typeof TraderPriceSchema>;

type MethodContext = {
  repoDir: string;
  globalArgs: GlobalArgs;
  logger: {
    info: (m: string, p?: Record<string, unknown>) => void;
    warning: (m: string, p?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource?: (name: string) => Promise<Record<string, unknown> | null>;
  dataRepository?: {
    findAllForModel: (
      type: string,
      modelId: string,
    ) => Promise<Array<Record<string, unknown>>>;
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
  modelType: string;
  modelId: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function brokerPaths(
  repoDir: string,
  args: GlobalArgs,
): { dir: string; spool: string; pid: string; status: string; script: string } {
  const dir = args.brokerDir.startsWith("/")
    ? args.brokerDir
    : `${repoDir}/${args.brokerDir}`;
  return {
    dir,
    spool: `${dir}/events.jsonl`,
    pid: `${dir}/broker.pid`,
    status: `${dir}/status.json`,
    script: `${dir}/broker.ts`,
  };
}

async function readJsonFile(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await DenoApi.readTextFile(path));
  } catch {
    return undefined;
  }
}

/** Build a broker process command without shell interpolation. */
export function brokerCommand(
  script: string,
  websocketUrl: string,
  dir: string,
): { command: string; args: string[] } {
  return {
    command: "deno",
    args: [
      "run",
      "--allow-net",
      "--allow-read",
      "--allow-write",
      script,
      websocketUrl,
      dir,
    ],
  };
}

type ProcessCommand = ReturnType<typeof brokerCommand>;
type ReadProcessFile = (path: string) => Promise<Uint8Array>;

/** Confirm a Linux PID is running this exact generated broker command. */
export async function isBrokerProcess(
  pid: number,
  command: ProcessCommand,
  readFile: ReadProcessFile = DenoApi.readFile,
): Promise<boolean> {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`);
    const argv = new TextDecoder().decode(raw).split("\0");
    while (argv.at(-1) === "") argv.pop();
    if (argv.length !== command.args.length + 1) return false;

    const executable = argv[0].split("/").at(-1);
    return executable === command.command &&
      command.args.every((arg, index) => argv[index + 1] === arg);
  } catch {
    // Missing /proc entries and permission/read failures must not trust the PID.
    return false;
  }
}

/** Return whether a direct trader price belongs to the current market window. */
export function isTraderPriceInWindow(
  price: { sourceTimestamp: number },
  cutoff: number,
): boolean {
  return price.sourceTimestamp >= cutoff;
}

async function brokerPid(paths: { pid: string }): Promise<number | undefined> {
  try {
    const raw = (await DenoApi.readTextFile(paths.pid)).trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

const BROKER_SCRIPT = String.raw`
const websocketUrl = Deno.args[0];
const dir = Deno.args[1];
const spoolPath = dir + "/events.jsonl";
const statusPath = dir + "/status.json";
const pidPath = dir + "/broker.pid";
await Deno.mkdir(dir, { recursive: true });
await Deno.writeTextFile(pidPath, String(Deno.pid));

let connected = false;
let received = 0;
let lastEventAt = null;
let reconnects = 0;
let lastError = null;

async function status(extra = {}) {
  const body = {
    pid: Deno.pid,
    websocketUrl,
    connected,
    received,
    reconnects,
    lastEventAt,
    lastError,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
  await Deno.writeTextFile(statusPath, JSON.stringify(body, null, 2));
}

function classify(payload) {
  if (payload && typeof payload === "object" && typeof payload.m === "string" && typeof payload.s === "string" && typeof payload.t === "number") return "trade";
  if (payload && typeof payload === "object" && (payload.buy || payload.sell)) return "traderPrices";
  if (payload && typeof payload === "object" && (Object.prototype.hasOwnProperty.call(payload, "since") || Object.prototype.hasOwnProperty.call(payload, "query"))) return "control";
  return "unknown";
}

async function append(kind, payload) {
  const event = { id: crypto.randomUUID(), kind, receivedAt: new Date().toISOString(), payload };
  await Deno.writeTextFile(spoolPath, JSON.stringify(event) + "\n", { append: true, create: true });
  received++;
  lastEventAt = event.receivedAt;
  await status();
}

async function connectLoop() {
  let delay = 1000;
  while (true) {
    await status({ state: "connecting" });
    const ws = new WebSocket(websocketUrl);
    let opened = false;
    await new Promise((resolve) => {
      ws.onopen = () => {
        opened = true;
        connected = true;
        delay = 1000;
        ws.send(JSON.stringify({ send_prices: 1 }));
        status({ state: "open" });
      };
      ws.onmessage = (evt) => {
        try {
          const text = typeof evt.data === "string" ? evt.data : "";
          const payload = JSON.parse(text);
          append(classify(payload), payload);
        } catch (err) {
          append("unknown", { parseError: String(err), raw: String(evt.data ?? "") });
        }
      };
      ws.onerror = (evt) => {
        lastError = evt && evt.message ? String(evt.message) : String(evt);
        status({ state: "error" });
      };
      ws.onclose = (evt) => {
        connected = false;
        reconnects++;
        status({ state: opened ? "closed" : "failed_to_open", closeCode: evt.code, closeReason: evt.reason, wasClean: evt.wasClean }).finally(resolve);
      };
    });
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(60000, Math.floor(delay * 1.8));
  }
}

addEventListener("unload", () => { try { Deno.removeSync(pidPath); } catch (_) {} });
await connectLoop();
`;

async function ensureBrokerScript(
  paths: { dir: string; script: string },
): Promise<void> {
  await DenoApi.mkdir(paths.dir, { recursive: true });
  await DenoApi.writeTextFile(paths.script, BROKER_SCRIPT);
}

async function readCursor(context: MethodContext): Promise<Cursor> {
  const raw = context.readResource
    ? await context.readResource("cursor-current")
    : null;
  if (!raw) return { offset: 0, updatedAt: nowIso() };
  return CursorSchema.parse(raw);
}

async function shaId(
  prefix: string,
  ...parts: Array<string | number | undefined>
): Promise<string> {
  const input = parts.map((p) => String(p ?? "")).join("|");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  const hex = Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  return `${prefix}-${hex.slice(0, 32)}`;
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseListing(
  messageId: string,
  payload: { m: string; s: string; t: number },
  catalog?: Catalog,
): TradeListing {
  const msg = payload.m.trim();
  const sideMatch = /\b(WTS|WTB)\b/i.exec(msg);
  const side = sideMatch
    ? sideMatch[1].toUpperCase() as "WTS" | "WTB"
    : "unknown";
  let afterSide = sideMatch
    ? msg.slice((sideMatch.index ?? 0) + sideMatch[0].length).trim()
    : msg;
  afterSide = afterSide.replace(/^[:\-\s]+/, "");

  const priceMatch =
    /(?:^|\s)(?:for\s+)?([0-9][0-9.,]*\s*(?:k|g|e|a|ecto|ectos|arm|arms|zkeys?|keys?)(?:\s*\/\s*ea)?|offer|offers|pm\s+offer|negotiable)\b/i
      .exec(afterSide);
  const priceRaw = priceMatch ? priceMatch[1].trim() : undefined;
  const itemPart = priceMatch
    ? afterSide.slice(0, priceMatch.index).trim().replace(/[,:;\-]+$/, "")
      .trim()
    : afterSide.split(/[;,]/)[0]?.trim();
  const quantityMatch = /^(\d+)\s*[xX]\s+/.exec(itemPart || "");
  const itemNameRaw = (itemPart || "").replace(/^(\d+)\s*[xX]\s+/, "").trim() ||
    undefined;

  let matchedItemName: string | undefined;
  if (itemNameRaw && catalog) {
    const wanted = normalizeName(itemNameRaw.replace(/\s+/g, " "));
    matchedItemName = catalog.items.find((i) => i.normalizedName === wanted)
      ?.name;
    if (!matchedItemName) {
      matchedItemName = catalog.items.find((i) =>
        wanted.includes(i.normalizedName) || i.normalizedName.includes(wanted)
      )?.name;
    }
  }

  let confidence = 0.2;
  if (side !== "unknown") confidence += 0.35;
  if (itemNameRaw) confidence += 0.25;
  if (priceRaw) confidence += 0.15;
  if (matchedItemName) confidence += 0.05;

  return {
    id: `${messageId}-listing-0`,
    messageId,
    side,
    user: payload.s,
    itemNameRaw,
    matchedItemName,
    priceRaw,
    quantityRaw: quantityMatch?.[1],
    message: msg,
    timestampMs: payload.t,
    parserVersion: "2026-07-06.1",
    confidence: Math.min(1, Number(confidence.toFixed(2))),
  };
}

function classifyPayload(
  payload: unknown,
): "trade" | "traderPrices" | "control" | "unknown" {
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    if (
      typeof obj.m === "string" && typeof obj.s === "string" &&
      typeof obj.t === "number"
    ) return "trade";
    if (obj.buy || obj.sell) return "traderPrices";
    if (
      Object.prototype.hasOwnProperty.call(obj, "since") ||
      Object.prototype.hasOwnProperty.call(obj, "query")
    ) return "control";
  }
  return "unknown";
}

async function appendCapturedEvent(
  spoolPath: string,
  kind: "trade" | "traderPrices" | "control" | "unknown",
  payload: unknown,
): Promise<void> {
  const raw = { id: crypto.randomUUID(), kind, receivedAt: nowIso(), payload };
  await DenoApi.writeTextFile(spoolPath, JSON.stringify(raw) + "\n", {
    append: true,
    create: true,
  });
}

async function captureWebsocketToSpool(
  websocketUrl: string,
  spoolPath: string,
  durationSeconds: number,
): Promise<{ received: number; opened: boolean; lastError?: string }> {
  let received = 0;
  let opened = false;
  let lastError: string | undefined;
  const pendingWrites: Array<Promise<void>> = [];
  const ws = new WebSocket(websocketUrl);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch (_) { /* ignore */ }
      resolve();
    }, durationSeconds * 1000);
    ws.onopen = () => {
      opened = true;
      ws.send(JSON.stringify({ send_prices: 1 }));
    };
    ws.onmessage = (evt) => {
      try {
        const payload = JSON.parse(String(evt.data ?? ""));
        pendingWrites.push(
          appendCapturedEvent(spoolPath, classifyPayload(payload), payload),
        );
        received++;
      } catch (err) {
        pendingWrites.push(
          appendCapturedEvent(spoolPath, "unknown", {
            parseError: String(err),
            raw: String(evt.data ?? ""),
          }),
        );
        received++;
      }
    };
    ws.onerror = (evt) => {
      lastError = evt && "message" in evt
        ? String((evt as ErrorEvent).message)
        : String(evt);
    };
    ws.onclose = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  await Promise.all(pendingWrites);
  return { received, opened, lastError };
}

async function readSpoolSlice(
  path: string,
  offset: number,
  maxEvents: number,
): Promise<{ lines: string[]; nextOffset: number; fileBytes: number }> {
  try {
    const stat = await DenoApi.stat(path);
    if (offset > stat.size) offset = 0;
    const file = await DenoApi.open(path, { read: true });
    try {
      await file.seek(offset, DenoApi.SeekMode.Start);
      const buf = new Uint8Array(
        Math.min(1024 * 1024 * 4, Math.max(0, stat.size - offset)),
      );
      const n = await file.read(buf) ?? 0;
      const text = new TextDecoder().decode(buf.subarray(0, n));
      const endsAtNewline = text.endsWith("\n");
      const parts = text.split("\n");
      if (!endsAtNewline) parts.pop();
      const lines = parts.filter(Boolean).slice(0, maxEvents);
      const consumedText = lines.map((l) => l + "\n").join("");
      return {
        lines,
        nextOffset: offset + new TextEncoder().encode(consumedText).length,
        fileBytes: stat.size,
      };
    } finally {
      file.close();
    }
  } catch {
    return { lines: [], nextOffset: offset, fileBytes: 0 };
  }
}

async function fetchCategory(
  apiUrl: string,
  title: string,
  maxPages: number,
): Promise<{
  members: Array<{ title: string; url?: string; isCategory: boolean }>;
  truncated: boolean;
}> {
  const out: Array<{ title: string; url?: string; isCategory: boolean }> = [];
  let cmcontinue = "";
  let pages = 0;
  do {
    const url = new URL(apiUrl);
    url.searchParams.set("action", "query");
    url.searchParams.set("list", "categorymembers");
    url.searchParams.set("cmtitle", title);
    url.searchParams.set("cmlimit", "500");
    url.searchParams.set("format", "json");
    if (cmcontinue) url.searchParams.set("cmcontinue", cmcontinue);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`wiki API failed ${res.status}`);
    const json = await res.json();
    for (const m of json.query?.categorymembers ?? []) {
      const memberTitle = String(m.title ?? "");
      const isCategory = memberTitle.startsWith("Category:");
      out.push({
        title: memberTitle,
        url: `https://wiki.guildwars.com/wiki/${
          encodeURIComponent(memberTitle.replace(/ /g, "_"))
        }`,
        isCategory,
      });
    }
    cmcontinue = json.continue?.cmcontinue ?? "";
    pages++;
  } while (cmcontinue && pages < maxPages);
  return { members: out, truncated: Boolean(cmcontinue) };
}

async function syncLiveItemMetadata(
  siteUrl: string,
): Promise<LiveItemMetadata> {
  const home = await fetch(siteUrl);
  if (!home.ok) throw new Error(`Kamadan homepage fetch failed ${home.status}`);
  const html = await home.text();
  const asset = /<script[^>]+src=["']([^"']*\/assets\/index-[^"']+\.js)["']/i
    .exec(html)?.[1];
  if (!asset) throw new Error("Could not find Kamadan bundled JS asset");
  const assetUrl = new URL(asset, siteUrl).toString();
  const jsRes = await fetch(assetUrl);
  if (!jsRes.ok) throw new Error(`Kamadan JS fetch failed ${jsRes.status}`);
  const js = await jsRes.text();

  const items: LiveItemMetadata["items"] = {};
  const staticBlock =
    /const\s+static_item_names_by_identifier\s*=\s*\{([\s\S]*?)\};/.exec(js)
      ?.[1] ?? "";
  for (
    const m of staticBlock.matchAll(/["']([^"']+)["']\s*:\s*["']([^"']+)["']/g)
  ) {
    items[m[1]] = { id: m[1], name: m[2], group: "unknown" };
  }

  const groupNames: Record<string, string> = {
    common_materials: "common_material",
    rare_materials: "rare_material",
    dyes: "dye",
    runes: "rune",
  };
  for (const [jsName, group] of Object.entries(groupNames)) {
    const block =
      new RegExp(`const\\s+${jsName}\\s*=\\s*\\[([\\s\\S]*?)\\];`).exec(js)
        ?.[1] ?? "";
    for (const m of block.matchAll(/["']([^"']+)["']/g)) {
      const id = m[1];
      items[id] = { id, name: items[id]?.name ?? id, group };
    }
  }

  return { syncedAt: nowIso(), source: assetUrl, items };
}

async function syncWikiCatalog(
  apiUrl: string,
  maxCategories: number,
  maxPagesPerCategory: number,
): Promise<Catalog> {
  const seenCategories = new Set<string>();
  const enqueuedCategories = new Set<string>(["Category:Items"]);
  const queue = ["Category:Items"];
  let truncated = false;
  const items = new Map<
    string,
    {
      name: string;
      normalizedName: string;
      wikiUrl?: string;
      categories: string[];
    }
  >();
  while (queue.length && seenCategories.size < maxCategories) {
    const category = queue.shift()!;
    if (seenCategories.has(category)) continue;
    seenCategories.add(category);
    const result = await fetchCategory(apiUrl, category, maxPagesPerCategory);
    truncated ||= result.truncated;
    for (const member of result.members) {
      if (member.isCategory) {
        if (!enqueuedCategories.has(member.title)) {
          enqueuedCategories.add(member.title);
          queue.push(member.title);
        }
      } else {
        const name = member.title.replace(/^.*:/, "");
        const key = normalizeName(name);
        const existing = items.get(key);
        if (existing) {
          if (!existing.categories.includes(category)) {
            existing.categories.push(category);
          }
        } else {
          items.set(key, {
            name,
            normalizedName: key,
            wikiUrl: member.url,
            categories: [category],
          });
        }
      }
    }
  }
  return {
    syncedAt: nowIso(),
    source: apiUrl,
    truncated: truncated || queue.length > 0,
    items: Array.from(items.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
  };
}

async function readAllResources<T>(
  context: MethodContext,
  specName: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  if (!context.dataRepository) return [];
  const all = await context.dataRepository.findAllForModel(
    context.modelType,
    context.modelId,
  );
  const decoder = new TextDecoder();
  const out: T[] = [];
  for (const d of all) {
    const name = String(d.name ?? "");
    const tags = d.metadata && typeof d.metadata === "object"
      ? (d.metadata as Record<string, unknown>).tags as
        | Record<string, unknown>
        | undefined
      : undefined;
    if (!name.startsWith(`${specName}-`) && tags?.specName !== specName) {
      continue;
    }
    const content = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      name,
      d.version as number | undefined,
    );
    if (!content) continue;
    try {
      out.push(schema.parse(JSON.parse(decoder.decode(content))));
    } catch {
      // ignore old/mismatched data
    }
  }
  return out;
}

/** Ingest and aggregate the Guild Wars Kamadan trade feed. */
export const model = {
  type: "@evrardjp/guildwars-kamadan",
  version: "2026.07.20.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    cursor: {
      description: "Broker spool cursor",
      schema: CursorSchema,
      lifetime: "infinite",
      garbageCollection: 100,
    },
    brokerStatus: {
      description: "Local websocket broker status",
      schema: BrokerStatusSchema,
      lifetime: "7d",
      garbageCollection: 100,
    },
    rawEvent: {
      description: "Raw Kamadan websocket event",
      schema: RawEventSchema,
      lifetime: "infinite",
      garbageCollection: 1,
    },
    tradeMessage: {
      description: "Raw Kamadan trade message",
      schema: TradeMessageSchema,
      lifetime: "infinite",
      garbageCollection: 1,
    },
    tradeListing: {
      description: "Parsed WTS/WTB listing with raw price text",
      schema: TradeListingSchema,
      lifetime: "infinite",
      garbageCollection: 1,
    },
    traderPrice: {
      description: "Direct trader price pushed by live Kamadan websocket",
      schema: TraderPriceSchema,
      lifetime: "infinite",
      garbageCollection: 1,
    },
    itemCatalog: {
      description: "One-time Guild Wars Wiki item catalog",
      schema: CatalogSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    liveItemMetadata: {
      description:
        "Item names/groups fetched from the live Kamadan website bundle",
      schema: LiveItemMetadataSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    marketHourly: {
      description:
        "Hourly market snapshot from WTB/WTS and direct trader prices",
      schema: MarketHourlySchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
  },
  methods: {
    startBroker: {
      description:
        "Start the local single-connection Kamadan websocket broker if it is not already running.",
      arguments: z.object({ restart: z.boolean().default(false) }),
      execute: async (args: { restart: boolean }, context: MethodContext) => {
        const paths = brokerPaths(context.repoDir, context.globalArgs);
        await DenoApi.mkdir(paths.dir, { recursive: true });
        const command = brokerCommand(
          paths.script,
          context.globalArgs.websocketUrl,
          paths.dir,
        );
        const pid = await brokerPid(paths);
        if (pid && await isBrokerProcess(pid, command)) {
          if (!args.restart) {
            const status = await readJsonFile(paths.status);
            const stat = await DenoApi.stat(paths.spool).catch(() => ({
              size: 0,
            }));
            const cursor = await readCursor(context);
            const handle = await context.writeResource(
              "brokerStatus",
              "brokerStatus-current",
              {
                running: true,
                pid,
                websocketUrl: context.globalArgs.websocketUrl,
                brokerDir: paths.dir,
                spoolPath: paths.spool,
                spoolBytes: stat.size,
                cursorOffset: cursor.offset,
                updatedAt: nowIso(),
                lastStatus: status,
              },
            );
            return { dataHandles: [handle] };
          }
          try {
            DenoApi.kill(pid, "SIGTERM");
          } catch {
            // The broker may have exited between the liveness check and signal.
          }
        }
        await ensureBrokerScript(paths);
        const child = new DenoCommand(command.command, {
          args: command.args,
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).spawn();
        const newPid = child.pid;
        child.unref();
        await DenoApi.writeTextFile(paths.pid, String(newPid));
        const cursor = await readCursor(context);
        const handle = await context.writeResource(
          "brokerStatus",
          "brokerStatus-current",
          {
            running: true,
            pid: newPid,
            websocketUrl: context.globalArgs.websocketUrl,
            brokerDir: paths.dir,
            spoolPath: paths.spool,
            spoolBytes: 0,
            cursorOffset: cursor.offset,
            updatedAt: nowIso(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    captureLiveFeed: {
      description:
        "Open one Kamadan websocket for a bounded interval, append live events to the local spool, then exit. Useful where background broker processes cannot survive the method sandbox.",
      arguments: z.object({
        durationSeconds: z.number().int().positive().max(120).default(18),
      }),
      execute: async (
        args: { durationSeconds: number },
        context: MethodContext,
      ) => {
        const paths = brokerPaths(context.repoDir, context.globalArgs);
        await DenoApi.mkdir(paths.dir, { recursive: true });
        const result = await captureWebsocketToSpool(
          context.globalArgs.websocketUrl,
          paths.spool,
          args.durationSeconds,
        );
        const cursor = await readCursor(context);
        const stat = await DenoApi.stat(paths.spool).catch(() => ({ size: 0 }));
        const handle = await context.writeResource(
          "brokerStatus",
          "brokerStatus-current",
          {
            running: false,
            websocketUrl: context.globalArgs.websocketUrl,
            brokerDir: paths.dir,
            spoolPath: paths.spool,
            spoolBytes: stat.size,
            cursorOffset: cursor.offset,
            updatedAt: nowIso(),
            lastStatus: { mode: "bounded-capture", ...result },
          },
        );
        return { dataHandles: [handle] };
      },
    },
    brokerStatus: {
      description: "Report local broker health and spool/cursor position.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const paths = brokerPaths(context.repoDir, context.globalArgs);
        const storedPid = await brokerPid(paths);
        const command = brokerCommand(
          paths.script,
          context.globalArgs.websocketUrl,
          paths.dir,
        );
        const running = storedPid
          ? await isBrokerProcess(storedPid, command)
          : false;
        const pid = running ? storedPid : undefined;
        const stat = await DenoApi.stat(paths.spool).catch(() => ({ size: 0 }));
        const cursor = await readCursor(context);
        const handle = await context.writeResource(
          "brokerStatus",
          "brokerStatus-current",
          {
            running,
            pid,
            websocketUrl: context.globalArgs.websocketUrl,
            brokerDir: paths.dir,
            spoolPath: paths.spool,
            spoolBytes: stat.size,
            cursorOffset: cursor.offset,
            updatedAt: nowIso(),
            lastStatus: await readJsonFile(paths.status),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    drainLiveFeed: {
      description:
        "Drain buffered websocket events from the local broker into Swamp datastore. Run every ~20 seconds.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const paths = brokerPaths(context.repoDir, context.globalArgs);
        const cursor = await readCursor(context);
        const { lines, nextOffset } = await readSpoolSlice(
          paths.spool,
          cursor.offset,
          context.globalArgs.maxDrainEvents,
        );
        const catalogRaw = context.readResource
          ? await context.readResource("itemCatalog-current")
          : null;
        const catalog = catalogRaw
          ? CatalogSchema.safeParse(catalogRaw).data
          : undefined;
        const handles: Array<{ name: string }> = [];
        const emittedNames = new Set<string>();
        const writeUnique = async (
          specName: string,
          name: string,
          data: Record<string, unknown>,
        ) => {
          if (emittedNames.has(name)) {
            context.logger.info(
              "Skipping duplicate data instance emitted during this drain",
              { specName, name },
            );
            return;
          }
          emittedNames.add(name);
          handles.push(await context.writeResource(specName, name, data));
        };
        for (const line of lines) {
          const raw = RawEventSchema.parse(JSON.parse(line));
          await writeUnique("rawEvent", `rawEvent-${raw.id}`, raw);
          if (raw.kind === "trade") {
            const p = raw.payload as {
              t: number;
              s: string;
              m: string;
              r?: number;
            };
            const messageId = await shaId("tradeMessage", p.t, p.s, p.m);
            const trade = {
              id: messageId,
              sourceTimestampMs: p.t,
              observedAt: raw.receivedAt,
              user: p.s,
              message: p.m,
              replacementOf: p.r,
            };
            await writeUnique(
              "tradeMessage",
              `tradeMessage-${messageId}`,
              trade,
            );
            const listing = parseListing(messageId, p, catalog);
            await writeUnique(
              "tradeListing",
              `tradeListing-${listing.id}`,
              listing,
            );
          } else if (raw.kind === "traderPrices") {
            const p = raw.payload as {
              buy?: Record<string, { p: string | number; t: number }>;
              sell?: Record<string, { p: string | number; t: number }>;
            };
            for (const side of ["buy", "sell"] as const) {
              for (const [modelKey, quote] of Object.entries(p[side] ?? {})) {
                const id = await shaId(
                  "traderPrice",
                  side,
                  modelKey,
                  quote.t,
                  quote.p,
                );
                const price = {
                  id,
                  side,
                  modelKey,
                  priceRaw: quote.p,
                  sourceTimestamp: quote.t,
                  observedAt: raw.receivedAt,
                };
                await writeUnique("traderPrice", `traderPrice-${id}`, price);
              }
            }
          }
        }
        const cursorHandle = await context.writeResource(
          "cursor",
          "cursor-current",
          { offset: nextOffset, updatedAt: nowIso() },
        );
        handles.push(cursorHandle);
        return { dataHandles: handles };
      },
    },
    syncLiveItemMetadata: {
      description:
        "Fetch item names/groups from the live Kamadan website bundle for common materials, rare materials, runes, and dyes.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const metadata = await syncLiveItemMetadata(
          context.globalArgs.websocketUrl.replace(/^wss:/, "https:").replace(
            /^ws:/,
            "http:",
          ),
        );
        const handle = await context.writeResource(
          "liveItemMetadata",
          "liveItemMetadata-current",
          metadata,
        );
        return { dataHandles: [handle] };
      },
    },
    syncItemCatalog: {
      description:
        "One-time/infrequent Guild Wars Wiki item catalog sync. Do not schedule frequently.",
      arguments: z.object({
        maxCategories: z.number().int().positive().max(1000).default(200),
        maxPagesPerCategory: z.number().int().positive().max(100).default(20),
      }),
      execute: async (
        args: { maxCategories: number; maxPagesPerCategory: number },
        context: MethodContext,
      ) => {
        const catalog = await syncWikiCatalog(
          context.globalArgs.wikiApiUrl,
          args.maxCategories,
          args.maxPagesPerCategory,
        );
        const handle = await context.writeResource(
          "itemCatalog",
          "itemCatalog-current",
          catalog,
        );
        return { dataHandles: [handle] };
      },
    },
    aggregateMarketValues: {
      description:
        "Compute hourly market snapshots from recent raw-price WTS/WTB listings and direct trader prices.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: MethodContext) => {
        const cutoff = Date.now() -
          context.globalArgs.marketWindowHours * 3600_000;
        const listings =
          (await readAllResources(context, "tradeListing", TradeListingSchema))
            .filter((l) => l.timestampMs >= cutoff && l.itemNameRaw);
        const prices = (await readAllResources(
          context,
          "traderPrice",
          TraderPriceSchema,
        )).filter((price) => isTraderPriceInWindow(price, cutoff));
        const metadataRaw = context.readResource
          ? await context.readResource("liveItemMetadata-current")
          : null;
        const liveMetadata = metadataRaw
          ? LiveItemMetadataSchema.safeParse(metadataRaw).data
          : undefined;
        const byItem = new Map<string, TradeListing[]>();
        for (const l of listings) {
          const key = l.matchedItemName || l.itemNameRaw || "unknown";
          byItem.set(key, [...(byItem.get(key) ?? []), l]);
        }
        const latestDirect = new Map<
          string,
          { buy?: TraderPrice; sell?: TraderPrice }
        >();
        for (const p of prices) {
          const entry = latestDirect.get(p.modelKey) ?? {};
          const current = entry[p.side];
          if (!current || p.sourceTimestamp > current.sourceTimestamp) {
            entry[p.side] = p;
          }
          latestDirect.set(p.modelKey, entry);
        }
        const hour = new Date(Math.floor(Date.now() / 3600_000) * 3600_000)
          .toISOString();
        const handles = [];
        for (const [itemName, rows] of byItem) {
          const wts = rows.filter((r) => r.side === "WTS").sort((a, b) =>
            b.timestampMs - a.timestampMs
          );
          const wtb = rows.filter((r) => r.side === "WTB").sort((a, b) =>
            b.timestampMs - a.timestampMs
          );
          const id = await shaId("marketHourly", hour, itemName);
          handles.push(
            await context.writeResource("marketHourly", `marketHourly-${id}`, {
              id,
              hour,
              itemName,
              group: "unknown",
              wtsSamples: wts.length,
              wtbSamples: wtb.length,
              latestWtsRaw: wts[0]?.priceRaw,
              latestWtbRaw: wtb[0]?.priceRaw,
              notes: [
                "Prices intentionally kept as raw strings; no normalization performed.",
              ],
            }),
          );
        }
        for (const [modelKey, entry] of latestDirect) {
          const id = await shaId("marketHourly", hour, modelKey, "direct");
          const live = liveMetadata?.items[modelKey];
          handles.push(
            await context.writeResource("marketHourly", `marketHourly-${id}`, {
              id,
              hour,
              itemName: live?.name ?? modelKey,
              group: live?.group ?? "direct-trader-price",
              wtsSamples: 0,
              wtbSamples: 0,
              directBuyRaw: entry.buy?.priceRaw,
              directSellRaw: entry.sell?.priceRaw,
              notes: [
                "Direct live trader price from Kamadan websocket send_prices feed.",
              ],
            }),
          );
        }
        return { dataHandles: handles };
      },
    },
  },
};
