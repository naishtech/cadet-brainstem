Build an MVP called "Cadet Token Saver".

## Objective

Create an npm/npx-installable local CLI that reduces the amount of context and tool output sent to AI coding agents.

The MVP should act as an orchestration/control layer around existing open-source tools rather than reimplementing them.

The initial integrations are:

1. RTK — terminal/output reduction
2. Serena — semantic code navigation
3. LeanCTX — context selection/compression/deduplication
4. Ollama — local LLM used only for task classification

The goal is to prove:

> Can we reduce AI-agent context consumption substantially without increasing rework or reducing task quality?

Do NOT build a cloud service, MCP server, sophisticated State Tree, cloud classifier, or payment system in this MVP.

---

# 1. CLI

Create an npm package that supports:

npx token-optimizer init

token-optimizer doctor

token-optimizer stats

token-optimizer dashboard

token-optimizer config

token-optimizer telemetry

The primary first-run experience should be:

npx token-optimizer init

It should:

1. Detect the operating system.
2. Detect whether Node/npm are available.
3. Detect whether Ollama is installed.
4. Detect whether RTK is installed.
5. Detect whether Serena is installed.
6. Detect whether LeanCTX is installed.
7. Report what is available.
8. Offer to install/configure missing components where this can be done safely.
9. Create a local Cadet Token Saver configuration.
10. Create a local metrics database/file.
11. Configure the integrations without modifying the user's project source code unnecessarily.

The command must be safe to run repeatedly.

---

# 2. Architecture

Use TypeScript/Node.js for Cadet Token Saver itself.

Keep the architecture modular:

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

The integration layer must use adapters/interfaces so the underlying tools can be replaced later.

For example:

interface ContextOptimizer {
  name: string;
  isAvailable(): Promise<boolean>;
  install?(): Promise<void>;
  configure?(): Promise<void>;
}

Do not fork RTK, Serena or LeanCTX.

Treat them as external optimisation primitives.

---

# 3. Local LLM classifier

Use Ollama.

The classifier must NOT be implemented using keyword matching.

Do not create logic such as:

if message.includes("debug") ...

Instead, send the user's current task/message to a small local Ollama model and require structured JSON output.

The classifier should classify:

task:
  question
  coding_new
  coding_fix
  debug
  refactor
  test
  review
  architecture
  documentation
  investigation
  planning
  search
  configuration

complexity:
  low
  medium
  high

risk:
  low
  medium
  high

context_need:
  minimal
  targeted
  broad
  exhaustive

precision:
  approximate
  normal
  exact

The output must be validated against a JSON schema.

If Ollama is unavailable, the system should degrade gracefully and use a conservative default policy. Do not silently fail.

The classifier prompt should explicitly tell the model:

- classify only
- do not solve the user's task
- return JSON only
- do not invent information
- prefer conservative classifications when uncertain

Make the model configurable:

classifier:
  provider: ollama
  model: <configured model>

Do not hard-code a single model name throughout the codebase.

---

# 4. Policy engine

Create a policy engine that converts the classifier result into an optimisation strategy.

Example:

DEBUG:
  context_need: broad
  compression: conservative
  code_search: semantic
  terminal_output: error-focused

CODING_NEW:
  context_need: targeted
  compression: normal
  code_search: semantic

QUESTION:
  context_need: minimal
  compression: aggressive

REFACTOR:
  context_need: structural
  compression: normal
  code_search: semantic

The policy engine must be deterministic.

The LLM classifies.
The policy engine decides.

Do not allow the LLM to directly execute tools or construct arbitrary shell commands.

Store policies in configuration rather than scattering them throughout the code.

---

# 5. RTK integration

Create an RTK adapter.

Its purpose is to reduce noisy terminal output before it becomes context.

Where possible:

Agent command
    ↓
Cadet Token Saver
    ↓
RTK
    ↓
reduced output
    ↓
agent

Never destroy the original output.

The full output must remain recoverable.

Record:

- command
- raw output size
- optimised output size
- estimated tokens before
- estimated tokens after
- estimated tokens saved
- timestamp

If RTK is unavailable, fall back to the normal command path.

---

# 6. Serena integration

Create a Serena adapter.

The purpose is to expose semantic code navigation when the selected policy requires it.

For example:

debug/refactor/coding_new
    ↓
Serena semantic search/navigation
    ↓
relevant symbols/files
    ↓
LeanCTX

Do not duplicate Serena's functionality.

Cadet Token Saver should only decide when semantic navigation is appropriate and provide the integration layer.

---

# 7. LeanCTX integration

Create a LeanCTX adapter.

LeanCTX should be treated as the context compiler.

Cadet Token Saver decides:

"What type of context does this task need?"

LeanCTX decides:

"What representation of that context should be returned?"

Support the major strategies exposed by LeanCTX:

- full
- raw
- lines
- diff
- reference
- signatures
- map
- cognitive
- task
- density
- aggressive

Do not reproduce LeanCTX's internal algorithms.

Pass an appropriate mode/budget based on the policy.

Record:

- source size
- returned context size
- mode
- estimated tokens saved
- task classification

---

# 8. Metrics

This is a critical part of the MVP.

Create a local metrics store.

SQLite is preferred.

Record optimisation events such as:

{
  timestamp,
  session_id,
  task_type,
  complexity,
  risk,
  tool,
  operation,
  estimated_input_tokens,
  estimated_output_tokens,
  estimated_tokens_saved,
  compression_ratio,
  optimisation_strategy
}

Do NOT store:

- source code
- full prompts
- conversation contents
- API keys
- credentials
- file contents

unless explicitly enabled by a future debug mode.

The metrics system must work completely offline.

---

# 9. Dashboard

Implement:

token-optimizer dashboard

For MVP, a lightweight local web dashboard is sufficient.

Show:

- estimated tokens processed
- estimated tokens saved
- percentage reduction
- optimisation events
- savings by tool
- savings by task type
- sessions
- average context reduction
- most expensive operations

Example:

Cadet Token Saver

Estimated tokens saved
4.2M

Context reduction
68%

RTK
1.4M saved

LeanCTX
2.1M saved

Serena
700K saved

Debugging
highest context usage

Clearly label all numbers as ESTIMATES where they are not directly measured.

Do not pretend to know exact model billing unless actual provider usage data is available.

---

# 10. Session tracking

Implement only a minimal session abstraction in the MVP.

Track:

session_id
started_at
ended_at
turn_count
task classification
estimated context size

Add configuration:

session:
  max_turns: 30

When the configured turn limit is reached, emit a warning:

"Context session has reached 30 turns. Consider starting a fresh session."

For MVP, DO NOT automatically create a sophisticated State Tree.

Instead generate a very small handoff file:

.token-optimizer/state.yaml

Example:

objective: "Fix Blueprint loading"

decisions:
  - "..."

unresolved:
  - "..."

pointers:
  - "Source/..."

last_action: "..."

next_action: "..."

This is intentionally dumb.

We want to test whether bounded sessions reduce cost before building the more sophisticated state-machine/state-tree system.

---

# 11. Telemetry

Implement optional anonymous telemetry.

It must be OFF by default unless the user explicitly opts in during setup.

The user should see exactly what is collected.

Potential telemetry:

- anonymous installation ID
- OS
- Cadet Token Saver version
- tool versions
- task classification
- estimated token savings
- compression ratios
- optimisation strategy
- aggregate session statistics

Never collect:

- source code
- prompts
- conversation text
- file names
- file paths
- credentials
- API keys
- repository identifiers

Provide:

token-optimizer telemetry status

token-optimizer telemetry on

token-optimizer telemetry off

The dashboard should work without telemetry.

Do not make the cloud backend part of this MVP unless absolutely necessary. Design the telemetry interface so a backend can be added later.

---

# 12. Doctor command

Implement:

token-optimizer doctor

Example output:

Cadet Token Saver Doctor

✓ Node.js
✓ npm
✓ Ollama
✓ Classifier model
✓ RTK
✓ Serena
✓ LeanCTX
✓ Metrics database
✓ Configuration

Warnings should explain exactly how to fix them.

Do not automatically modify the user's environment from doctor.

---

# 13. Configuration

Use a human-readable config file.

Example:

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

Policies should be configurable but have sensible defaults.

---

# 14. Safety principles

These are important.

1. Never silently discard information that cannot be recovered.
2. Full/raw output must remain accessible.
3. Explicit user requests for exact/raw/full context override optimisation.
4. The LLM classifier must never directly execute commands.
5. Optimisation failures must fall back to the original behaviour.
6. Never require cloud connectivity for core functionality.
7. Never collect source code or prompts for telemetry.
8. Clearly distinguish measured values from estimates.
9. Never claim that compression preserves correctness unless tested.
10. Every optimisation should be reversible/debuggable.

---

# 15. What NOT to build

Do NOT build:

- cloud MCP server
- subscription/payment system
- sophisticated State Tree
- automatic conversation summarisation
- custom context compression algorithms
- custom semantic search
- custom code intelligence
- remote LLM classifier
- automatic model selection
- enterprise administration
- team collaboration
- complicated UI
- token billing integration

The existing tools already solve much of this.

The MVP is an orchestration + measurement layer.

---

# 16. Success criteria

The MVP is successful if we can run real coding tasks and demonstrate:

1. The local classifier reliably identifies task type.
2. Policies select sensible optimisation strategies.
3. RTK reduces noisy command output.
4. Serena provides semantic navigation where appropriate.
5. LeanCTX reduces context size.
6. Metrics accurately record estimated savings.
7. Sessions can be bounded without breaking normal workflow.
8. The system gracefully falls back when an optimisation tool is unavailable.
9. No source code or prompts leave the machine unless telemetry explicitly allows it.
10. The developer experience is simple enough that the user can install everything with:

npx token-optimizer init

---

# 17. Development approach

Build this incrementally.

Phase 1:
CLI + config + doctor

Phase 2:
Ollama classifier + JSON schema validation

Phase 3:
Policy engine

Phase 4:
RTK adapter

Phase 5:
Serena adapter

Phase 6:
LeanCTX adapter

Phase 7:
metrics

Phase 8:
dashboard

Phase 9:
session tracking + minimal state.yaml

Phase 10:
telemetry interface

After each phase, write tests.

Prefer integration tests using mocked external tools rather than requiring every dependency to be installed in CI.

At the end, provide:

- README
- installation instructions
- architecture documentation
- configuration reference
- security/privacy documentation
- example policies
- test suite
- build/package scripts

The final result should be a genuinely usable npm package, not a prototype consisting of mocked functionality.

Most importantly:

**Do not invent replacement implementations for RTK, Serena or LeanCTX. Cadet Token Saver's value is the intelligence, orchestration, measurement and developer experience sitting above them.**