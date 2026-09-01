## Plan: Enforce Procedure Handoffs

Cadet Brainstem currently recommends procedures to the cloud LLM, but the cloud model can ignore them. Make procedure execution authoritative through MCP-side state and validation while preserving current compatibility fields.

**Steps**

1. **Define a structured procedure contract**
   - Include procedure ID, ordered actions, risk tier, approval requirement, and review token.
   - Add it to MCP steering output and `UserPromptSubmit` hook context.
   - Do not advertise procedures when steering or procedure lookup is degraded.

2. **Track review state**
   - Store reviewed procedure ID, repository, exact argument fingerprint, review result, and expiry.
   - Use an injectable state abstraction for isolated tests.
   - Use short-lived SQLite state only if MCP and hooks require cross-process coordination.

3. **Enforce MCP sequencing**
   - `procedure_review` issues a review token after producing the review.
   - `procedure_apply` requires:
     - Matching procedure ID
     - Matching repository
     - Matching reviewed arguments
     - Unexpired review token
     - Explicit `approved: true`
   - Return machine-readable errors such as `REVIEW_REQUIRED`, `REVIEW_MISMATCH`, and `APPROVAL_REQUIRED`.
   - Prevent token reuse after successful application.

4. **Strengthen VS Code hooks**
   - Update `hook-procedure-review` to validate review metadata when available.
   - Register it in the generated `PreToolUse` hooks alongside existing redirect/rewrite hooks.
   - Preserve unrelated user hooks and document ordering/coexistence.
   - Make the prompt context state that manual execution is not an alternative to a matched procedure.

5. **Add tests**
   - Cover the complete match → review → approve → apply flow.
   - Reject apply before review, approval without review, changed arguments, changed repository, wrong procedure ID, expired tokens, and reused tokens.
   - Preserve read-only procedure behavior and existing steering fields.
   - Test hook generation and lifecycle context.
   - Update [scripts/agent-loop-write-e2e.ts](e:/dev/cadet-brainstem/scripts/agent-loop-write-e2e.ts) to use the real ordered flow.

6. **Update documentation**
   - Update [README.md](e:/dev/cadet-brainstem/README.md), [docs/integration-vscode.md](e:/dev/cadet-brainstem/docs/integration-vscode.md), and relevant task/design documents.
   - Document review tokens, refusal codes, hook registration, and the limits of prompt-only compliance.
   - Keep `approved: true` for compatibility, but require matching review metadata for writes.

7. **Verify**
   - Run focused procedure and hook tests.
   - Run the scratch-repository E2E.
   - Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`.
   - Inspect generated hooks and confirm VS Code loads them after reload.
   - Repeat the MCP initialize and `tools/list` handshake.

**Primary files**

- [src/mcp/server.ts](e:/dev/cadet-brainstem/src/mcp/server.ts): MCP contracts, review/apply enforcement, and steering output.
- [src/cli/commands/hook-procedure-review.ts](e:/dev/cadet-brainstem/src/cli/commands/hook-procedure-review.ts): hook-level review gate.
- [src/cli/commands/hook-lifecycle.ts](e:/dev/cadet-brainstem/src/cli/commands/hook-lifecycle.ts): procedure handoff context.
- [src/procedure/execute.ts](e:/dev/cadet-brainstem/src/procedure/execute.ts): existing execution and write-step rules.
- [test/procedure-matcher.test.ts](e:/dev/cadet-brainstem/test/procedure-matcher.test.ts): procedure contract and enforcement tests.
- [test/hook-lifecycle.test.ts](e:/dev/cadet-brainstem/test/hook-lifecycle.test.ts): hook context and registration tests.

**Key decision**

Server-side enforcement is the authority. Steering instructions improve cloud LLM compliance, but they are not a security boundary. Write procedures should require a server-issued review token bound to the exact repository and arguments.