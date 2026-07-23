## 2026.07.23.2

**Added:** The `@evrardjp/github-repo-review-focus` report classifies every
mirrored open pull request into a deterministic reviewer action queue and
includes reviewer load, label concentration, large changes, path overlap, and
stale backlog summaries in Markdown and JSON.

**Changed:** Model definitions can configure `reviewerHandles` and
`reviewFocusStaleDays`. Report rendering uses stored mirror data only and marks
missing current-HEAD or collection data as incomplete instead of ready.

**Upgrade note:** Existing models remain valid with no configured reviewer
handles and a 14-day stale threshold. Configure `reviewerHandles` to enable the
personal Re-review and Requested From You queues.
