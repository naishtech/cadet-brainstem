/**
 * Verify that RTK and LeanCTX can actually execute against the current
 * repository (cwd). Answers: are the binaries available, and can they run a
 * command / read a repo file — before we rely on them for procedure execution.
 */
import { RtkAdapter } from '../src/integrations/rtk';
import { LeanCtxAdapter } from '../src/integrations/leanctx';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(exec);

async function which(bin: string): Promise<boolean> {
  try {
    await execP(`${bin} --version`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  console.log('cwd:', cwd);

  const rtkAvail = await which('rtk');
  const leanAvail = await which('lean-ctx');
  console.log('rtk binary available:', rtkAvail);
  console.log('lean-ctx binary available:', leanAvail);

  // RTK: run a command against the repo.
  if (rtkAvail) {
    const rtk = new RtkAdapter();
    try {
      const result = await rtk.optimize({ command: 'git status --short', cwd });
      console.log('\nRTK git status (degraded=' + result.degraded + '):');
      console.log((result.optimisedOutput || result.rawOutput).slice(0, 300));
    } catch (err) {
      console.log('\nRTK error:', (err as Error).message);
    }
  } else {
    console.log('\nRTK: binary not found on PATH.');
  }

  // LeanCTX: read a repo file.
  if (leanAvail) {
    const lean = new LeanCtxAdapter();
    try {
      const result = await lean.optimize({ target: 'package.json', mode: 'map', taskType: 'config' });
      console.log('\nLeanCTX read package.json (degraded=' + result.degraded + ', saved=' + result.estimatedTokensSaved + '):');
      console.log(result.context.slice(0, 300));
    } catch (err) {
      console.log('\nLeanCTX error:', (err as Error).message);
    }
  } else {
    console.log('\nLeanCTX: binary not found on PATH.');
  }
}

void main();
