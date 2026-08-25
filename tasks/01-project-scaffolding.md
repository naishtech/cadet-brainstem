# Task 01 — Project Scaffolding

**Status:** Implemented on branch `task/01-project-scaffolding` (pending review/commit)
**Phase:** Phase 1 (foundation)
**Source:** `docs/plans/initial_design.md` — §1 CLI, §2 Architecture

## Objective

Create the npm package skeleton for Cadet Token Saver so later tasks can build on a stable, typed foundation.

## Details

- Package name: `token-optimizer` (per the `npx token-optimizer ...` CLI examples in the design doc).
- Language: TypeScript / Node.js.
- Modular source layout matching the design doc:

```
src/
  cli/
  core/
  classifier/
  policy/
  integrations/
    rtk/
    serena/
    leanctx/
  metrics/
  state/
  dashboard/
  config/
```

- Set up `package.json` with `bin` entry pointing at the CLI, `scripts` for `build`, `test`, `lint`, and a `dev`/`watch` script.
- Set up `tsconfig.json` with strict settings and appropriate output to `dist/`.
- Add a build tool (e.g. `tsup` or plain `tsc`) and verify the package can be built and executed via `npx`.
- Add `.gitignore` (node_modules, dist, `.token-optimizer/` local state, SQLite db files).
- Add `LICENSE` reference (repo already has a `LICENSE`).
- Define the shared adapter interface (from §2 Architecture) in `src/core/` so RTK/Serena/LeanCTX adapters (Tasks 08–10) and future tools can be swapped behind it:

```ts
interface ContextOptimizer {
  name: string;
  isAvailable(): Promise<boolean>;
  install?(): Promise<void>;
  configure?(): Promise<void>;
}
```

## Acceptance Criteria

- [ ] `npm run build` produces runnable output in `dist/`.
- [ ] Directory structure from the design doc exists.
- [ ] Package installs/resolves via `npx token-optimizer` without error.
- [ ] TypeScript compiles with strict mode enabled and no errors.
- [ ] `.gitignore` prevents committing local state, build output, and the metrics database.
