# Root README Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the outdated root README and prevent unreviewed content drift through an exact CI-enforced contract and repository guidance.

**Architecture:** Store the approved text in both `README.md` and a canonical fixture. A dependency-free shell validator compares them exactly; a shell regression test proves matching content passes and drift fails; GitHub Actions runs the validator on every pull request. `AGENTS.md` provides the always-loaded human and agent policy.

**Tech Stack:** Markdown, Bash, GitHub Actions YAML, ShellCheck

## Global Constraints

- The README begins tersely, states independent extension lifecycle, then explains the generic repository structure.
- Do not name or describe individual extensions.
- Do not include relationship diagrams, machine-local paths, or development commands.
- CI compares `README.md` with the canonical fixture byte for byte.
- Do not add a project skill for this invariant; use root `AGENTS.md` guidance.

---

### Task 1: Root README Contract

**Files:**
- Modify: `README.md`
- Create: `scripts/root-readme.md`
- Create: `scripts/check-root-readme.sh`
- Create: `scripts/check-root-readme-test.sh`
- Create: `.github/workflows/root-readme-contract.yml`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: repository root as the current working directory
- Produces: `scripts/check-root-readme.sh [README [CANONICAL]]`, exiting zero only when files match

- [ ] **Step 1: Write the failing shell regression test**

Create a temporary matching pair and a changed pair. Assert that
`scripts/check-root-readme.sh` is currently missing, establishing RED before
implementation.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bash scripts/check-root-readme-test.sh`

Expected: non-zero because `scripts/check-root-readme.sh` does not exist.

- [ ] **Step 3: Add the minimal comparison script**

Use `cmp -s` for the decision and `diff -u` for actionable failure output. The
optional arguments let the regression test use temporary fixtures; defaults
must be `README.md` and `scripts/root-readme.md`.

- [ ] **Step 4: Run the regression test to verify it passes**

Run: `bash scripts/check-root-readme-test.sh`

Expected: zero with matching content accepted and changed content rejected.

- [ ] **Step 5: Add the approved README and canonical copy**

The two files must be byte-identical and contain only the approved terse
introduction, independent lifecycle statement, and generic repository map.

- [ ] **Step 6: Add CI and repository guidance**

Add an always-on pull-request and manual-dispatch workflow with read-only
contents permission. Replace the conflicting `AGENTS.md` instruction requiring
new extensions in the root README with the exact generic README invariant.

- [ ] **Step 7: Verify the complete contract**

Run:

```bash
bash scripts/check-root-readme-test.sh
bash scripts/check-root-readme.sh
shellcheck scripts/check-root-readme.sh scripts/check-root-readme-test.sh
git diff --check
```

Expected: all commands exit zero.
