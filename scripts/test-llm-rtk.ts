/**
 * End-to-end test of the core capability: the LOCAL LLM drives RTK to read a
 * directory/file, then reports the results back. This is the smallest proof
 * that "cloud hands off -> local LLM executes with its tools -> reports back"
 * works, before we invest in mining.
 *
 * Loop:
 *   1. Local LLM proposes an RTK shell command for a task.
 *   2. We execute it via the RtkAdapter against the repo (cwd).
 *   3. RTK output is fed back to the local LLM.
 *   4. Local LLM reports the results.
 */
import { resolveBaseModel } from '../src/steering';
import { RtkAdapter } from '../src/integrations/rtk';

const HOST = process.env.OLLAMA_HOST ?? 'http://localhost:11434';

async function llmJson(prompt: string, schema: object): Promise<Record<string, unknown>> {
  const response = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: resolveBaseModel(),
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      format: schema,
      think: false,
      options: { temperature: 0, num_predict: 400 },
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama HTTP ${response.status}`);
  }
  const data = (await response.json()) as { message?: { content?: string } };
  return JSON.parse(data.message?.content ?? '{}') as Record<string, unknown>;
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  console.log('cwd:', cwd);
  console.log('model:', resolveBaseModel());

  // Step 1: local LLM proposes an RTK command to list the current directory.
  const plan = (await llmJson(
    [
      'You have a tool "rtk" that runs a shell command and returns its output.',
      'The working directory is a git repository.',
      'Task: list the files and directories in the current directory and report them.',
      'Respond with JSON: {"command": "<shell command to list the current directory>"}.',
    ].join('\n'),
    { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  )) as { command?: string };
  console.log('\nLLM proposed RTK command:', plan.command);
  if (!plan.command) {
    console.log('No command proposed.');
    return;
  }

  // Step 2: execute via RTK against the repo.
  const rtk = new RtkAdapter();
  const result = await rtk.optimize({ command: plan.command, cwd });
  const output = result.optimisedOutput || result.rawOutput;
  console.log('RTK degraded:', result.degraded, '| output bytes:', output.length);

  // Step 3: feed RTK output back to the local LLM to report.
  const report = (await llmJson(
    [
      'Here is the output of running a command to list the current directory:',
      '"""',
      output.slice(0, 3000),
      '"""',
      'Summarize what files and directories are present, concisely.',
    ].join('\n'),
    { type: 'object', properties: { report: { type: 'string' } }, required: ['report'] },
  )) as { report?: string };
  console.log('\nLLM report:\n', report.report);
}

void main();
