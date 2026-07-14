# GitHub is a read-only mirror

**Source of truth:** LastGit `lastdb:///situations` (code node).

GitHub Actions workflows here are **intentionally inert** (`workflow_dispatch`
noops). Do not re-enable push/PR CI on GitHub — agent merge gates run via
`.lastgit/ci.sh` on the forge host.

Public clone/browse on GitHub remains welcome; PRs opened only on GitHub will
not be the merge path (see `.last-stack/pr-venue`).
