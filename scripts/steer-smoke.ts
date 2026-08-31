/**
 * Real-Ollama smoke test for the steering (Task 03).
 *
 * Runs the actual OllamaSteerer against a local Ollama server so we can
 * validate the riskiest assumption early: does a small local model return
 * valid structured JSON steering?
 *
 * Usage:
 *   npm run steer:smoke                    # run with default sample requests
 *   npm run steer:smoke -- "your message"  # steer a specific request
 *
 * Prereqs: Ollama installed + running (ollama serve), and a model pulled,
 * e.g. `ollama pull qwen3:4b`. The model is read from config
 * (~/.cadet-brainstem/config.yaml) unless CADET_BRAINSTEM_CONFIG points
 * elsewhere.
 */
import { steer, isOllamaAvailable } from '../src/steering/index';

const DEFAULT_SAMPLES = [
  'Fix the Blueprint loading so actors appear in the level.',
  'Explain what dependency injection is in simple terms.',
  'Add a new save-file serialization format.',
  'Why does the render thread crash on startup?',
  'Refactor the inventory system to use composition over inheritance.',
];

async function main(): Promise<void> {
  const samples = process.argv.slice(2);
  const requests = samples.length > 0 ? samples : DEFAULT_SAMPLES;

  process.stdout.write('Checking Ollama availability... ');
  if (!(await isOllamaAvailable())) {
    process.stdout.write('unreachable\n');
    console.error(
      [
        '',
        'Ollama is not reachable (expected at http://localhost:11434).',
        '  - Start it:  ollama serve',
        '  - Pull a model:  ollama pull qwen3:4b',
        '  - Then re-run:  npm run steer:smoke',
      ].join('\n'),
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write('available\n\n');

  for (const text of requests) {
    process.stdout.write(`Steering: ${text}\n`);
    try {
      const result = await steer(text);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(
        `  FAILED: ${(err as Error).message}`,
      );
    }
    process.stdout.write('\n');
  }
}

main();
