#!/usr/bin/env node
// Blockbench MCP server.
//
// Exposes Blockbench's modeling / texturing / animation / rendering capabilities
// as MCP tools over stdio. It is a CLIENT of the Blockbench MCP Bridge plugin,
// which runs inside the Blockbench desktop app and hosts a local TCP server.
//
// Flow:  LLM client  <--stdio/MCP-->  this server  <--TCP/NDJSON-->  Blockbench plugin
//
// IMPORTANT: this process speaks MCP over stdout. Never write logs to stdout;
// all diagnostics go to stderr.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BridgeClient, DEFAULT_HOST, DEFAULT_PORT } from './bridge-client.js';
import { registerAllTools } from './tools.js';

const log = (...args) => process.stderr.write('[blockbench-mcp] ' + args.join(' ') + '\n');

const bridge = new BridgeClient({
  host: process.env.BLOCKBENCH_MCP_HOST || DEFAULT_HOST,
  port: Number(process.env.BLOCKBENCH_MCP_PORT || DEFAULT_PORT),
  token: process.env.BLOCKBENCH_MCP_TOKEN || '',
  requestTimeoutMs: Number(process.env.BLOCKBENCH_MCP_TIMEOUT || 60000),
  log,
});

if (!bridge.token) {
  log('WARNING: BLOCKBENCH_MCP_TOKEN is not set. The bridge requires a token; ' +
      'run "MCP Bridge: Status" in Blockbench to copy it, then set BLOCKBENCH_MCP_TOKEN.');
}

const server = new McpServer(
  {
    name: 'blockbench',
    version: '0.1.0',
  },
  {
    instructions:
      'Drive the Blockbench 3D model editor: create projects, build models from cubes/groups/meshes, ' +
      'create and paint textures, set up UVs, author animations, and render the model to images. ' +
      'Workflow: ensure a project exists (bb_status / bb_create_project), build geometry, create + paint ' +
      'textures, apply them, then bb_render_view to SEE the result and iterate. For anything not covered by ' +
      'a dedicated tool, use bb_execute_script (full Blockbench JS API). The Blockbench desktop app must be ' +
      'running with the "MCP Bridge" plugin enabled.',
  }
);

registerAllTools(server, bridge);

// Try to connect up front so the bridge is warm, but do not fail startup if
// Blockbench is not running yet — tools will (re)connect lazily on first use.
bridge.connect().catch((err) => {
  log(`Blockbench not reachable yet at ${bridge.host}:${bridge.port} (${err.message}). ` +
      'Will retry when a tool is called. Make sure Blockbench is open with the MCP Bridge plugin enabled.');
});

const transport = new StdioServerTransport();
await server.connect(transport);
log(`server ready (bridge target ${bridge.host}:${bridge.port})`);

const shutdown = () => {
  try { bridge.close(); } catch {}
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
