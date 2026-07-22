# Roadmap

Phase 1 establishes Floci health and S3 protocol coverage. The approved later
phases remain intentionally upstream-first:

## Phase 4: AWS lifecycle

Expand deterministic AWS service lifecycle coverage, persistence, restart,
concurrency, and failure-mode tests while keeping every cloud operation behind a
Swamp model method.

## Phase 5: AWS vault and upstream models

Exercise AWS credential vault integration and official `@swamp/aws/*` models
against Floci. Contribute compatibility fixes upstream first; fork a model only
as a documented last resort when an upstream change cannot serve real AWS and
Floci safely.

## Phase 6: Azure

Add an equivalent local-emulator protocol suite for Azure, beginning with
health, blob lifecycle, persistence, and datastore-adjacent behavior.

## Phase 7: GCP

Add an equivalent local-emulator protocol suite for GCP, beginning with health,
object lifecycle, persistence, and datastore-adjacent behavior.

## Phase 8: Cross-provider suite

Unify AWS, Azure, and GCP scenarios into a provider-neutral compatibility suite
with shared evidence, issue-draft, lifecycle, restart, lock, and cleanup rules.
