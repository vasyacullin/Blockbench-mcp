// contract.test.js
// Guards against drift between the MCP tool definitions (server/tools.js) and the
// command handlers implemented in the Blockbench plugin. Every tool's bridge
// `method` must have a matching handler in the plugin, and every plugin handler
// should be reachable from a tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { TOOLS } from '../tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginSrc = readFileSync(path.join(__dirname, '..', '..', 'plugin', 'blockbench_mcp_bridge.js'), 'utf8');

// Methods exposed by the server: those in the TOOLS table plus the separately
// registered render tool.
const toolMethods = new Set([...TOOLS.map((t) => t.method), 'render_view']);

// Extract handler keys from the `const handlers = { ... }` object literal.
const JS_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'do', 'with']);

function extractHandlerNames(src) {
  const start = src.indexOf('const handlers = {');
  assert.ok(start >= 0, 'could not find the handlers object in the plugin');
  // Bound the slice to the handlers object literal (ends at the first `\n\t};`).
  const end = src.indexOf('\n\t};', start);
  assert.ok(end > start, 'could not find the end of the handlers object');
  const body = src.slice(start, end);
  const names = new Set();
  // Method definitions sit at exactly two tabs of indentation inside the object.
  const re = /\n\t\t(?:async\s+)?([a-z_][a-z0-9_]*)\s*\(/g;
  let m;
  while ((m = re.exec(body))) {
    if (!JS_KEYWORDS.has(m[1])) names.add(m[1]);
  }
  return names;
}

const handlerNames = extractHandlerNames(pluginSrc);

test('every MCP tool method has a plugin handler', () => {
  const missing = [...toolMethods].filter((m) => !handlerNames.has(m));
  assert.deepEqual(missing, [], `tool methods with no plugin handler: ${missing.join(', ')}`);
});

test('every plugin handler is exposed by a tool', () => {
  const orphan = [...handlerNames].filter((h) => !toolMethods.has(h));
  assert.deepEqual(orphan, [], `plugin handlers with no MCP tool: ${orphan.join(', ')}`);
});

test('plugin registers itself with an id matching its filename', () => {
  assert.match(pluginSrc, /PLUGIN_ID\s*=\s*'blockbench_mcp_bridge'/);
  assert.match(pluginSrc, /Plugin\.register\(PLUGIN_ID,/);
});
