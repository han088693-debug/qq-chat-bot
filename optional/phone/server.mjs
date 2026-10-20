#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, ROOT } from '../config.mjs';
import { createPhoneTools } from './core.mjs';

const server = new McpServer({ name: 'phone', version: '1.0.0' });
const tools = createPhoneTools(loadConfig(), {
  readBridgeConfig: () => JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')),
});
for (const tool of tools) {
  server.registerTool(tool.name, {
    description: tool.description, inputSchema: tool.schema, annotations: tool.annotations,
  }, async (args) => {
    try { return await tool.invoke(args); }
    catch (error) {
      return { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : '工具执行失败' }] };
    }
  });
}
await server.connect(new StdioServerTransport());
