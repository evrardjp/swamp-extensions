## 2026.07.20.1

**Fixed:** Broker startup no longer evaluates configured URLs or paths as shell
code, and hourly aggregation excludes stale direct trader prices.

**Changed:** Wiki pagination is bounded per category and catalog output reports
when results were truncated.

**Fixed:** Broker lifecycle operations now verify that persisted PIDs belong to
the expected generated broker command before reporting or signaling them.
