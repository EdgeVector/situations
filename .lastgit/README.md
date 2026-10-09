# .lastgit

Gate of record is GitHub (EdgeVector/situations) since 2026-09-30.

- `ci.sh` is the portable gate body (shell syntax, install, typecheck, build). The tests are deleted. `.github/workflows/ci-required.yml` runs it in the `check` job; the final job `ci-required` is the required status check.
- `artifacts.json` declares the host-track artifact. The `publish` job (push to main) builds it on a macOS runner with last-stack's reusable workflow.
- The LastGit copy is frozen. Do not open a LastGit change request.
