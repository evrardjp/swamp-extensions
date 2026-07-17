# @evrardjp/guildwars-kamadan

Ingests the Guild Wars Kamadan websocket trade feed into Swamp and builds
queryable trade, item, and hourly market data.

## Model Type

`@evrardjp/guildwars-kamadan`

The model supports bounded websocket capture, optional local broker operation,
spool draining, Guild Wars Wiki catalog synchronization, live item metadata,
and hourly aggregation. Prices remain raw source values and are not normalized.

The broker methods require local filesystem access and `deno`; feed and catalog
methods require outbound network access.

## Example

```yaml
globalArguments:
  websocketUrl: wss://kamadan.gwtoolbox.com/
  brokerDir: .swamp/kamadan-broker
  wikiApiUrl: https://wiki.guildwars.com/api.php
  maxDrainEvents: 500
  marketWindowHours: 24
```

Use bounded capture where background processes cannot survive the Swamp method
sandbox, then drain and aggregate the captured records:

```bash
swamp model method run guildwars-kamadan captureLiveFeed --input durationSeconds=18
swamp model method run guildwars-kamadan drainLiveFeed
swamp model method run guildwars-kamadan aggregateMarketValues
```

Catalog synchronization is intentionally separate from frequent ingestion.
`syncItemCatalog` traverses Guild Wars Wiki categories and should run only
occasionally. `syncLiveItemMetadata` reads the current Kamadan web bundle. Raw
events and raw price strings are retained so future parsers can replay source
data without inventing historical normalized prices.
