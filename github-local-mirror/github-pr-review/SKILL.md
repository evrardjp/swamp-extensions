---
name: github-pr-review
description: >
  Show the local Swamp report for a GitHub PR or issue number and, only with
  permission, create current-HEAD review analysis. Use for requests such as
  "show me the report for PR 42" or "show me the report for issue 17".
---

# GitHub PR Review

Use Swamp as the only GitHub data interface. Never call GitHub directly or use
`gh`, `curl`, a GitHub SDK, or remote URLs. Local `git` is allowed only during
the approved analysis flow and only through commands supplied by the report.

## Workflow

1. Resolve the target `@evrardjp/github-local-mirror` model with
   `swamp model search --json`. If none or several plausibly match, ask the user
   to choose; do not infer a repository from GitHub. Normalize the subject to
   `subjectType: pr|issue` and a positive integer `number`.
2. Run the future method:

   ```sh
   swamp model method run <model> prepare_review_context \
     --input subjectType=<pr|issue> --input number=<number>
   ```

3. Retrieve both structured and display forms of the generated report:

   ```sh
   swamp report get @evrardjp/github-pr-context --model <model> --json
   swamp report get @evrardjp/github-pr-context --model <model> --markdown
   ```

   If exact CLI syntax differs, consult `swamp model method run --help` or
   `swamp report --help`; do not replace Swamp with another data source.
4. Inspect JSON before displaying anything. Confirm the requested subject,
   deterministic report, current PR HEAD, and `llmEvidence.current`. Evidence
   is current only when `llmEvidence.current` exists and its recorded HEAD
   exactly equals the report's current HEAD. Treat missing, unequal, or
   unverifiable HEAD values as absent/stale. For an issue with no current PR
   HEAD, analysis is not applicable: show the deterministic issue report.
5. If current evidence exists, show the report. If the deterministic report
   exists but evidence for the current HEAD is absent/stale, ask exactly:

   > The deterministic report is ready, but current-HEAD LLM evidence is missing or stale. Generate it now?

   Stop and wait for an explicit yes or no. Never present stale analysis as
   current.
6. On no, show only the deterministic report. Omit stale analysis or label it
   explicitly as stale historical evidence; never merge it into current
   findings.
7. On yes, use only the report's supplied local, read-only Git commands. Do not
   edit the commands, synthesize additional Git commands, fetch, or contact a
   remote. Reject commands that are destructive, write state, or do not target
   the reported local repository and current HEAD. Analyze their output as the
   current conversational agent; do not select or assume an LLM provider.
8. Produce `codePathWalkthrough` and `reviewAttentionMap`. Every material claim
   must cite an `evidenceRefs` entry such as `path:line`, commit SHA, or a
   report-provided local artifact identifier. Distinguish observed facts from
   review hypotheses. Preserve external references only as unresolved URL
   strings; never follow, fetch, summarize, or claim to validate them.
9. Write YAML input under a write-approved path inside the active workspace,
   never in the mirrored Git object directory or an arbitrary external path.
   Use the `analysisInput` template returned in the report JSON. Include
   `prNumber`, the exact current `headSha`, a non-empty `generator`,
   `codePathWalkthrough`, `reviewAttentionMap`, and `evidenceRefs`. Do not
   include credentials or unrelated command output. Then run:

   ```sh
   swamp model method run <model> record_pr_analysis --input-file <approved-yaml-path>
   ```

10. Rerun `prepare_review_context`, retrieve the JSON report again, and verify
    that `llmEvidence.current` now matches the exact current HEAD and contains
    both generated sections and evidence references. Only then retrieve and
    show the final Markdown report. If verification fails, report the failure
    and show the deterministic report without representing the analysis as
    current.

## Verification

- The report subject type and number equal the request.
- The current HEAD is taken from fresh report JSON, never from stale evidence.
- Recorded analysis uses that exact HEAD.
- The post-record report exposes matching `llmEvidence.current`.
- External references remain unresolved URLs.
- No GitHub-facing command was run outside Swamp.

## Pitfalls

- A successful method run does not prove evidence freshness; compare HEADs.
- Do not reuse analysis after the PR HEAD changes, even if paths look unchanged.
- Do not generate analysis before receiving an explicit yes.
- Do not improvise Git inspection when report-supplied commands are absent or
  unsafe; show the deterministic report and explain the blocker.
- Do not expose stale analysis under a current-analysis heading.
- Do not confuse an issue number with a PR number; preserve `subjectType`.
