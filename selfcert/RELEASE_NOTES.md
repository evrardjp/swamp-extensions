## 2026.07.06.1

**Fixed:** Certificate generation now uses Swamp's runtime `vaultService.put` API when no test vault hook is provided.

**Added:** A regression test covering runtimes that do not expose vault write support.

**Changed:** Missing runtime vault write support now reports `context.vaultService.put` in the error message.

**Upgrade note:** No model argument or resource schema changes are required.
