/**
 * Task 38, Part B — benchmark command-output compression: RTK
 * (`compress_command_output`) vs LeanCTX `ctx_shell`.
 *
 * Runs a representative set of read-only commands, captures a raw baseline,
 * then compresses the same command through RTK and through LeanCTX's `ctx_shell`
 * and compares retained bytes (ratio), estimated tokens, and latency.
 *
 * Run: `npm run benchmark:shell` (ensure RTK + lean-ctx are on PATH).
 */
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { RtkAdapter } from '../src/integrations/rtk';
import { LeanCtxAdapter } from '../src/integrations/leanctx';

const exec = promisify(execCb);

/** Representative read-only commands (Windows git-bash friendly). */
const COMMANDS = [
  'git status',
  'git status --short',
  'git log --oneline -20',
  'git diff --stat',
  'ls -la',
];

const cwd = process.cwd();

async function runRaw(command: string): Promise<string> {
  const { stdout, stderr } = await exec(command, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60_000,
  });
  return stderr ? `${stdout}\n${stderr}` : stdout;
}

interface Row {
  command: string;
  rawBytes: number;
  rtkBytes: number;
  rtkRatio: number;
  rtkMs: number;
  ctxBytes: number;
  ctxRatio: number;
  ctxMs: number;
}

async function main(): Promise<void> {
  const rtk = new RtkAdapter();
  const lean = new LeanCtxAdapter();
  // Warm up the lean-ctx mcp session so spawn time is not counted in timings.
  await lean.listTools({ cwd });

  const rows: Row[] = [];
  for (const command of COMMANDS) {
    let raw: string;
    try {
      raw = await runRaw(command);
    } catch {
      raw = '(command failed)';
    }
    const rawBytes = Buffer.byteLength(raw);
    if (rawBytes === 0) {
      console.log(`skip (empty output): ${command}`);
      continue;
    }

    let rtkBytes = rawBytes;
    let rtkMs = 0;
    try {
      const t0 = performance.now();
      const r = await rtk.optimize({ command, cwd });
      rtkMs = Math.round(performance.now() - t0);
      if (!r.degraded) rtkBytes = Buffer.byteLength(r.optimisedOutput);
    } catch {
      /* keep raw */
    }

    let ctxBytes = rawBytes;
    let ctxMs = 0;
    try {
      const t0 = performance.now();
      const r = await lean.callTool({
        tool: 'ctx_shell',
        arguments: { command, cwd },
        cwd,
      });
      ctxMs = Math.round(performance.now() - t0);
      if (!r.degraded) ctxBytes = Buffer.byteLength(r.rawText);
    } catch {
      /* keep raw */
    }

    rows.push({
      command,
      rawBytes,
      rtkBytes,
      rtkRatio: rawBytes ? rtkBytes / rawBytes : 1,
      rtkMs,
      ctxBytes,
      ctxRatio: rawBytes ? ctxBytes / rawBytes : 1,
      ctxMs,
    });
    console.log(
      `${command}\n` +
        `  raw=${rawBytes}B  RTK=${rtkBytes}B (${(rtkBytes / rawBytes * 100).toFixed(0)}%) ${rtkMs}ms  ` +
        `ctx_shell=${ctxBytes}B (${(ctxBytes / rawBytes * 100).toFixed(0)}%) ${ctxMs}ms`,
    );
  }

  await lean.close();

  const n = rows.length;
  if (n === 0) {
    console.log('\nNo rows to summarize.');
    return;
  }
  const avgRtkRatio = rows.reduce((s, r) => s + r.rtkRatio, 0) / n;
  const avgCtxRatio = rows.reduce((s, r) => s + r.ctxRatio, 0) / n;
  const avgRtkMs = rows.reduce((s, r) => s + r.rtkMs, 0) / n;
  const avgCtxMs = rows.reduce((s, r) => s + r.ctxMs, 0) / n;
  const rtkSaved = (1 - avgRtkRatio) * 100;
  const ctxSaved = (1 - avgCtxRatio) * 100;

  console.log('\n--- summary ---');
  console.log(
    `avg retained ratio: RTK=${(avgRtkRatio * 100).toFixed(1)}%  ctx_shell=${(avgCtxRatio * 100).toFixed(1)}%`,
  );
  console.log(
    `avg tokens saved:   RTK=${rtkSaved.toFixed(0)}%  ctx_shell=${ctxSaved.toFixed(0)}%`,
  );
  console.log(`avg latency:        RTK=${avgRtkMs.toFixed(0)}ms  ctx_shell=${avgCtxMs.toFixed(0)}ms`);

  // Routing decision (recorded in the task doc).
  const winner = avgCtxRatio < avgRtkRatio ? 'ctx_shell' : 'rtk';
  console.log(`\nDecision: prefer "${winner}" for command-output compression (lower retained ratio).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
