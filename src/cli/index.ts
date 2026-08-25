#!/usr/bin/env node

const VERSION = '0.1.0';

function printHelp(): void {
  console.log(`cadet-token-saver — Cadet Token Saver CLI

Usage:
  cadet-token-saver <command>

Commands:
  init        Set up configuration and integrations (first run)
  doctor      Check environment health
  stats       Show saved/processed token metrics
  dashboard   Open the local metrics dashboard
  config      View or edit configuration
  telemetry   Manage anonymous telemetry

Options:
  --version   Print version
  --help      Show this help

Note: full command routing is implemented in a later task.`);
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(VERSION);
    return;
  }

  console.error(
    `cadet-token-saver: unknown command "${args[0]}" — run "cadet-token-saver --help".`,
  );
  process.exitCode = 1;
}

main();
