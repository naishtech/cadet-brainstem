#!/usr/bin/env node
'use strict';
/*
 * Cadet Token Saver — binary entry.
 *
 * The real implementation is the ESM bundle at ../dist/index.js. We wrap it in
 * a tiny CJS launcher for one reason: Node emits an ExperimentalWarning when the
 * built-in `node:sqlite` module is first loaded ("SQLite is an experimental
 * feature"). That warning fires while the ESM bundle is being instantiated, so
 * an in-bundle patch is too late. By patching `process.emitWarning` here (CJS
 * runs top-to-bottom on require) BEFORE dynamically importing the bundle, we
 * suppress exactly that expected warning without hiding any others.
 */
const originalEmitWarning = process.emitWarning.bind(process);

process.emitWarning = function (warning, ...args) {
  const opts =
    args[0] && typeof args[0] === 'object' ? args[0] : undefined;
  const type =
    typeof args[0] === 'string' ? args[0] : (opts && (opts.type ?? opts.name));
  const message =
    typeof warning === 'string' ? warning : (warning && warning.message) || '';
  if (type === 'ExperimentalWarning' && String(message).includes('SQLite')) {
    return;
  }
  return originalEmitWarning(warning, ...args);
};

import('../dist/index.js');
