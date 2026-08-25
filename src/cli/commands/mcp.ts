import { runMcpServer } from '../../mcp';
import type { CliCommand } from '../types';

export const mcpCommand: CliCommand = {
  name: 'mcp',
  description: 'Run the local MCP server (VS Code agent integration)',
  usage: 'cadet-token-saver mcp',
  run(): Promise<number> {
    return runMcpServer();
  },
};
