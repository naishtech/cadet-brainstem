# Cadet Brainstem — Requirements

What you need installed to run Cadet Brainstem and its integrations.

## Core

- **Node.js 18+** — runtime
- **npm** — package management

## Local LLM classifier

- **Ollama** — local LLM server used by the classifier.
  - Native install: https://ollama.com
  - Or Docker: `docker run -d --name ollama -v ollama:/root/.ollama -p 11434:11434 --restart unless-stopped ollama/ollama`
- **Model (default):** `qwen3:1.7b` — pull with: `ollama pull qwen3:1.7b`

## Integration tools

### RTK (terminal/output reduction) — https://github.com/rtk-ai/rtk

A single Rust binary that compresses command output before it reaches the agent.

**Windows:** download `rtk-x86_64-pc-windows-msvc.zip` from the [releases page](https://github.com/rtk-ai/rtk/releases), extract it, and put `rtk.exe` on your PATH (e.g. `~/.local/bin`).

Note: the `install.sh` script is **Linux/macOS only** — it does NOT support Windows/Git Bash (errors with "Unsupported operating system"). On Windows use the zip above.

Verify: `rtk --version`

### LeanCTX (context intelligence / compression) — https://github.com/yvgude/lean-ctx

A local Rust binary that decides what context an agent reads and how it is represented.

**Windows:** download `lean-ctx-x86_64-pc-windows-msvc.zip` from the [releases page](https://github.com/yvgude/lean-ctx/releases), extract it, and put `lean-ctx.exe` on your PATH (e.g. `~/.local/bin`).

Other platforms: `curl -fsSL https://leanctx.com/install.sh | sh`, `brew install lean-ctx`, or `cargo install lean-ctx`. (`npm i -g lean-ctx-bin` may fail to fetch the binary on Windows.)

Verify: `lean-ctx --version` (or `lean-ctx doctor`)

### Serena (semantic code navigation)

Semantic code search/navigation used when a policy requires it.

Install per its own documentation. Verify: `serena --version`

## Notes

- `cadet-brainstem doctor` reports which tools are installed and how to fix missing ones.
- Missing integration tools degrade gracefully — the pipeline still runs; only that tool's savings are unavailable.
