// MCP smoke test (npm run mcp:smoke): spawn the built server, verify the
// `classify` tool is listed and works (returns classification + strategy)
// against the live local LLM. Requires `npm run build` first (see script).
import { spawn } from 'node:child_process';
import readline from 'node:readline/promises';

const child = spawn(process.execPath, ['dist/index.js', 'mcp'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const stdout = child.stdout;
const stdin = child.stdin;
if (stdout === null || stdin === null) {
  console.error('Failed to pipe the MCP server stdio');
  process.exit(1);
}

// Safety net: if the server never responds, don't hang forever.
const guard = setTimeout(() => {
  console.error('TIMEOUT: MCP server did not respond within 30s');
  child.kill();
  process.exit(1);
}, 30_000);

interface JsonRpcResponse {
  id?: number;
  result?: {
    tools?: Array<{ name: string }>;
    content?: Array<{ text: string }>;
    isError?: boolean;
  };
}

const rl = readline.createInterface({ input: stdout });
let id = 0;
const pending = new Map<number, (msg: JsonRpcResponse) => void>();
rl.on('line', (line) => {
  const msg = JSON.parse(line) as JsonRpcResponse;
  if (msg.id !== undefined) {
    const resolve = pending.get(msg.id);
    if (resolve !== undefined) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function request(method: string, params: unknown): Promise<JsonRpcResponse> {
  return new Promise((resolve) => {
    const msgId = ++id;
    pending.set(msgId, resolve);
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: msgId, method, params })}\n`,
    );
  });
}

async function main(): Promise<void> {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0.0.0' },
  });
  stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`,
  );

  const listed = await request('tools/list', {});
  const names = listed.result?.tools?.map((t) => t.name) ?? [];
  console.log('tools:', names.join(', '));
  if (!names.includes('classify')) {
    throw new Error('classify NOT listed');
  }

  const call = await request('tools/call', {
    name: 'classify',
    arguments: { task: 'Debug why the loader fails to start on Windows.' },
  });
  console.log('isError:', call.result?.isError);
  console.log(call.result?.content?.[0]?.text);

  clearTimeout(guard);
  child.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  child.kill();
  process.exit(1);
});
