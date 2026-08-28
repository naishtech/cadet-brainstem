#!/usr/bin/env node
// MUST be the first import: filters the node:sqlite ExperimentalWarning
// before any transitively-imported module loads `node:sqlite`.
import './suppress-warnings';
import { runCli } from './commands';

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

void main();

