# swamp-extensions

Community extensions for Swamp, maintained by evrardjp. See each extension's
README for its purpose and usage.

Each top-level extension directory is independently versioned, tested, and
published.

## Repository structure

```text
swamp-extensions/
  <extension>/
    .swamp.yaml                Swamp repository marker
    manifest.yaml              Extension metadata and entry points
    README.md                  Extension-specific documentation
    deno.json                  Deno tasks and dependencies
    RELEASE_NOTES.md           Current release notes, when present
    *.ts                       Implementation and tests, when present
    models/                    Model implementations, when present
    vaults/                    Vault implementations, when present
    datastores/                Datastore implementations, when present
    drivers/                   Driver implementations, when present
    reports/                   Report implementations, when present
    workflows/                 Workflow definitions, when present
  .agents/                     Project agent resources
  .github/
    workflows/                 CI, validation, and publishing workflows
    dependabot.yml             Automated dependency updates
  docs/                        Project design and implementation documents
  scripts/                     Repository maintenance and validation scripts
  AGENTS.md                    Contributor and automation guidance
```
