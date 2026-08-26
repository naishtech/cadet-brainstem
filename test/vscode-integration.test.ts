import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relative: string): string {
  return readFileSync(join(root, relative), 'utf8');
}

describe('VS Code integration files', () => {
  it('registers the MCP server in .vscode/mcp.json', () => {
    const mcp = JSON.parse(read('.vscode/mcp.json')) as {
      servers?: Record<
        string,
        { type?: string; command?: string; args?: string[] }
      >;
    };
    const server = mcp.servers?.['cadet-token-saver'];
    expect(server).toBeDefined();
    expect(server?.type).toBe('stdio');
    expect(server?.command).toBe('cadet-token-saver');
    expect(server?.args).toContain('mcp');
  });

  it('ships runnable VS Code tasks including a wrap example', () => {
    const tasks = JSON.parse(read('.vscode/tasks.json')) as {
      tasks?: Array<{ label?: string }>;
    };
    const labels = tasks.tasks?.map((task) => task.label ?? '') ?? [];
    expect(labels).toContain('cadet: init');
    expect(labels).toContain('cadet: doctor');
    expect(labels).toContain('cadet: stats');
    expect(labels).toContain('cadet: wrap (git status)');
  });

  it('AGENTS.md steers the agent to the tools and wrapper', () => {
    const agents = read('AGENTS.md');
    expect(agents).toContain('optimize_context');
    expect(agents).toContain('find_relevant_symbols');
    expect(agents).toContain('compress_command_output');
    expect(agents).toContain('cadet-token-saver wrap');
  });

  it('documents the VS Code integration including wrap tasks', () => {
    const doc = read('docs/integration-vscode.md');
    expect(doc).toContain('.vscode/mcp.json');
    expect(doc).toContain('Tasks: Run Task');
    expect(doc).toContain('cadet: wrap (git status)');
    expect(doc).toContain('npm link');
  });
});
