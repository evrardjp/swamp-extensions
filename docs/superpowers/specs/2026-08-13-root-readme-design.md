# Root README Design

## Goal

Replace the outdated extension catalog with durable, generic repository
documentation.

## Content

The root README will contain, in order:

1. A terse description of the repository and a pointer to each extension's own
   README.
2. A statement that extension directories are independently versioned, tested,
   and published.
3. A generic repository map covering extension contents, GitHub workflows and
   Dependabot configuration, maintenance scripts, project documentation, and
   contributor guidance.

The map will use `<extension>` and generic filenames rather than naming current
extensions. Optional extension files and directories will be identified as
optional.

## Exclusions

The README will not contain an extension catalog, extension-specific
descriptions, relationship diagrams, local filesystem paths, or development
commands.

## Enforcement

The approved README will also be stored as a canonical fixture. A repository
script will compare `README.md` with that fixture byte for byte and print the
diff when they differ. This deliberately requires any root README change to
update the reviewed fixture too.

A dedicated GitHub Actions workflow will run the script on every pull request
and on manual dispatch. It will use read-only repository permissions and no
external runtime dependencies beyond checkout and the shell available on the
runner.

Root `AGENTS.md` guidance will require agents and contributors to keep the root
README generic, put extension-specific documentation in each extension's own
README, and update the canonical fixture only for intentional policy changes.
The existing instruction to add new extensions to the root README will be
removed. A separate skill is unnecessary because this is an always-applicable
repository invariant rather than an optional workflow.

The comparison script will have a shell test proving that matching content
passes and changed content fails. Both scripts will pass ShellCheck.

## Verification

Review the rendered Markdown and confirm that every documented repository-level
path exists and no individual extension is named. Run the comparison test,
validate the real README against the fixture, run ShellCheck, and syntax-check
the workflow.
