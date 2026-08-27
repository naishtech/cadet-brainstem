# 39 — `response_policy` object + recommended language standard

**Status:** Implemented (ad-hoc refinement, uncommitted at time of writing)

Record of two ad-hoc refinements to the classifier response (not a numbered
feature task):

## 1. `response_policy` is now an object
Refactored from a flat list of directive keys into an object the **cloud LLM**
must follow when composing its reply:

```json
"response_policy": {
  "directives": ["delta_only", "no_filler"],
  "language_standard": "microsoft"
}
```

- New `ResponsePolicy` interface (`{ directives: ResponsePolicyKey[],
  language_standard?: LanguageStandard }`).
- Backward-compatible: a legacy flat-array `response_policy` is normalized to
  `{ directives }`.
- The local classifier (`qwen3`) only *recommends* this; the cloud LLM follows
  it via `AGENTS.md` steering.

## 2. Recommended `language_standard`
The classifier picks one documentation style guide from a fixed, validated set:

| key | standard |
| --- | --- |
| `asd_ste100` | ASD-STE100 — controlled, safety-critical/runbooks |
| `microsoft` | Microsoft Style Guide — developer/product docs |
| `google` | Google Style Guide — API docs/tutorials |
| `diataxis` | Diátaxis — documentation portals |
| `iso_24495` | ISO 24495 — plain language, general |
| `ieee` | IEEE — academic/research |

Nested under `response_policy.language_standard`; sanitized (invalid dropped),
taught in the prompt.

## Validation
Build, typecheck, lint green; test suite green.
