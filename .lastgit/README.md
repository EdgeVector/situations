# LastGit home — situations (GitHub = public mirror)

| Role | Location |
|------|----------|
| **SoT / CR / CI / merge** | `lastdb:///situations` on code node |
| **Public mirror** | `https://github.com/EdgeVector/situations` (read-only for merge) |

## Workflow

1. Agents open CRs with `lastgit cr` (venue = `lastgit`).
2. Multi-repo forge runs `.lastgit/ci.sh` → `ci-required` → auto-merge.
3. Mirror job pushes LastGit `main` → GitHub `main` (see `sync-github-mirror.sh`).

GitHub Actions are inert. Do not merge on GitHub.

## Pin

```bash
export LASTGIT_SOCKET=$HOME/.lastgit/code/data/folddb.sock
export LASTGIT_SCHEMA_MAP=$HOME/.lastgit/schema-map.json
```

`fsituations` is the same product (CLI alias); one git slug: `situations`.
