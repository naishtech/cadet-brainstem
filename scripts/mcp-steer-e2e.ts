// MCP smoke test (npm run mcp:smoke): spawn the built server, verify the
// `steer` tool is listed and works (returns steering + strategy)
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
  if (!names.includes('steering')) {
    throw new Error('steer NOT listed');
  }

  // Store a short memory for the project so steer can pick it up.
  const memStore = await request('tools/call', {
    name: 'chat_memory_store',
    arguments: {
      action: 'store',
      content:
        'Loader gotcha: Windows startup path requires special handling\nObserved on CI and Windows 10',
      tags: ['gotcha'],
    },
  });
  console.log('memory stored, isError:', memStore.result?.isError);

  const call = await request('tools/call', {
    name: 'steering',
    arguments: { task: 'loader' },
  });
  console.log('isError:', call.result?.isError);
  console.log(call.result?.content?.[0]?.text);

  // Verify the steer response contains relevant_memories
  try {
    const text = call.result?.content?.[0]?.text;
    if (!text) {
      throw new Error('no steer text');
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if ((parsed.relevant_memories as unknown[]) === undefined) {
      console.error('no relevant_memories in steer response');
      child.kill();
      process.exit(2);
    }
    console.log('relevant_memories:', (parsed.relevant_memories as unknown[]).length);
    // Response-schema smoke checks (Task 36): guidance + evidence_plan present.
    if (
      typeof parsed.guidance !== 'string' ||
      parsed.guidance.trim().length === 0
    ) {
      console.error('no non-empty guidance in steer response');
      child.kill();
      process.exit(2);
    }
    const ep = parsed.evidence_plan as { prioritized_queries?: unknown[] } | null;
    if (ep === null || typeof ep !== 'object' || !Array.isArray(ep.prioritized_queries)) {
      console.error('no evidence_plan.prioritized_queries in steer response');
      child.kill();
      process.exit(2);
    }
    console.log(
      'guidance:',
      parsed.guidance,
      '| evidence_plan queries:',
      ep.prioritized_queries.length,
    );
  } catch (err) {
    console.error('failed to validate steer response:', (err as Error).message);
    child.kill();
    process.exit(2);
  }

  clearTimeout(guard);
  child.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  child.kill();
  process.exit(1);
});
