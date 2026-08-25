# Task 24 — NPM Publishing

**Status:** Not started
**Phase:** Release (post-MVP features)
**Source:** Reference example — `E:\unity\projects\cadet-agent` (`publish-npm.ps1`, `package.json`); design doc §1 (`npx token-optimizer init`), §17 ("genuinely usable npm package", "build/package scripts")

## Objective

Publish `token-optimizer` to the npm registry so real users can install it with `npx token-optimizer init`, following the `cadet-agent` publishing example.

**Prerequisite:** This task runs last, after all MVP features (Tasks 01–21), the test suite/build scripts (Task 22), and README/docs (Task 23) are complete — the package must be feature-complete, tested, and documented before it ships.

## Details

Follow the `cadet-agent` example (`publish-npm.ps1` + `package.json`). Its approach:

### 1. `publish-npm.ps1` (repo root)

Replicate the cadet-agent script, adapted to `token-optimizer`:

- Read the npm token from `~/.npm_token`. The file must contain ONLY the granular access token (created at `https://www.npmjs.com/settings/<user>/tokens` with **Publish** permission and **Bypass 2FA** enabled).
- If the token file is missing or empty, fail with clear, copy-pasteable setup instructions (do NOT publish without a token).
- Normalize LF line endings before publishing (Windows git can convert to CRLF, which breaks the bin shebang on Unix): for this repo, ensure `dist/index.js` (and any other shebang/bin files) use LF.
- Authenticate and publish in one step so the token is never persisted to npm config:
  - `npm whoami --//registry.npmjs.org/:_authToken=$token` (print the authenticated user)
  - `npm publish --//registry.npmjs.org/:_authToken=$token`
- Clean up any previously persisted token: `npm config delete "//registry.npmjs.org/:_authToken"`.
- `$ErrorActionPreference = "Stop"` and non-zero exit handling on failure.

### 2. `package.json` publishing metadata

Match the example's publishing fields (ours already has most — verify/complete):

- `bin` → `dist/index.js` (already set)
- `files` → `["dist"]` (already set) — confirm the packed tarball contains only `dist/`, `LICENSE`, `README.md`
- `license`, `engines`, `keywords` (already set)
- ADD `repository` and `homepage` fields pointing at the actual GitHub repo once the remote is known (the example uses `naishtech/cadet-agent`; fill in the real token-optimizer URL)
- ADD a `prepublishOnly` script that runs `typecheck`, `lint`, `test`, `build` before publish so an untested/unbuilt package can never ship (small safety extension to the example)

### 3. Versioning & changelog

- Follow the example's `CHANGELOG.md` convention — keep it updated per release.
- Bump `version` per semver before publishing (do not publish stale versions).
- Optionally tag releases with `v*.*.*` and a GitHub release, mirroring `release.yml` — but the MVP requirement is the npm package, not a GitHub release.

### 4. Safety

- The token lives ONLY in `~/.npm_token` (outside the repo). Never commit it, never write it to repo files or `.npmrc`, and ensure `.gitignore` covers any local npm state.
- Before the real publish, verify with `npm pack` / `npm publish --dry-run` to inspect the tarball contents.

## Acceptance Criteria

- [ ] `publish-npm.ps1` exists and follows the cadet-agent example (token file, LF normalization, inline auth, publish, cleanup).
- [ ] `package.json` has `repository` + `homepage` and a working `prepublishOnly` (typecheck + lint + test + build).
- [ ] `npm publish --dry-run` shows only intended files (`dist/`, `LICENSE`, `README.md`, `package.json`) and no secrets.
- [ ] A published/dev-packaged install works: `npx token-optimizer init` runs successfully.
- [ ] Token is never persisted to npm config or committed to the repo.
- [ ] `CHANGELOG.md` exists and reflects the release.
