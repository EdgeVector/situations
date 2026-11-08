# .lastgit

Gate of record is GitHub (EdgeVector/situations) since 2026-09-30.

- `ci.sh` is the portable gate body (shell syntax, install, typecheck, build). The tests are deleted. `.github/workflows/ci-required.yml` runs it in the `check` job; the final job `ci-required` is the required status check.
