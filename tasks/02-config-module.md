# Task 02 — Config Module

**Risk rationale:** Enabler — the classifier (Task 03) needs a configurable model name and defaults; low risk but required before the riskiest assumption can be exercised.

**Status:** Not started
**Phase:** Phase 1
**Source:** `docs/plans/initial_design.md` — §13 Configuration

## Objective

Implement the configuration system: human-readable config file, schema, defaults, loading, and saving.

## Details

Config file is human-readable YAML with these defaults (from §13):

```yaml
classifier:
  provider: ollama
  model: qwen3:4b

session:
  max_turns: 30

optimisation:
  enabled: true
  default_budget: 12000

telemetry:
  enabled: false

tools:
  rtk: true
  serena: true
  leanctx: true
```

- Do NOT hard-code a single model name throughout the codebase — `classifier.model` must be configurable.
- Provide a typed config schema (use a validation lib like `zod`, or hand-rolled type guards).
- `load()` should apply defaults when fields are missing.
- `save()` should write a clean, human-readable YAML file.
- `getConfigPath()` should return a stable local path (e.g. `~/.token-optimizer/config.yaml` or project-local `.token-optimizer/config.yaml`). Pick one documented location and keep it consistent across tasks.
- Provide helpers to read/write individual values (used by the `config` command).

## Acceptance Criteria

- [ ] Default config matches the design doc exactly.
- [ ] Missing/partial config loads with defaults filled in.
- [ ] Saving produces valid YAML that round-trips back to the same object.
- [ ] `classifier.model` is read from config, never hard-coded.
- [ ] Config is validated; invalid values produce clear errors.
