// smoke.test.js
// End-to-end: spawn the real MCP server, point it at a mock Blockbench bridge,
// and drive it through the official MCP client. Verifies tool discovery, request
// forwarding (params reach the bridge), text results, and image results.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMockBridge } from './mock-bridge.js';
import { BridgeClient } from '../bridge-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, '..', 'index.js');

let mock;
let client;
let transport;

before(async () => {
  mock = await startMockBridge('testtoken');
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: { ...process.env, BLOCKBENCH_MCP_PORT: String(mock.port), BLOCKBENCH_MCP_TOKEN: mock.token },
    stderr: 'pipe',
  });
  client = new Client({ name: 'smoke-test', version: '1.0.0' });
  await client.connect(transport);
});

after(async () => {
  try { await client?.close(); } catch {}
  try { mock?.server.close(); } catch {}
});

test('lists the expected tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of [
    'bb_status', 'bb_create_project', 'bb_add_cube', 'bb_add_group', 'bb_add_mesh',
    'bb_create_texture', 'bb_paint_rect', 'bb_paint_pixels', 'bb_get_texture',
    'bb_set_face_uv', 'bb_create_animation', 'bb_add_keyframe', 'bb_render_view',
    'bb_list_actions', 'bb_run_action', 'bb_select', 'bb_set_mode', 'bb_set_setting',
    'bb_execute_script',
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  // Every tool must carry a description and an input schema.
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 10, `${t.name} needs a description`);
    assert.ok(t.inputSchema, `${t.name} needs an inputSchema`);
  }
});

test('bb_status forwards and returns text', async () => {
  const res = await client.callTool({ name: 'bb_status', arguments: {} });
  assert.equal(res.isError, undefined);
  const text = res.content.find((c) => c.type === 'text').text;
  assert.match(text, /blockbench/);
  assert.ok(mock.received.some((m) => m.method === 'status'));
});

test('bb_create_project forwards params to the bridge', async () => {
  await client.callTool({ name: 'bb_create_project', arguments: { format: 'bedrock', name: 'mob' } });
  const req = mock.received.find((m) => m.method === 'create_project');
  assert.ok(req, 'create_project request not received');
  assert.equal(req.params.format, 'bedrock');
  assert.equal(req.params.name, 'mob');
});

test('bb_add_cube validates and forwards vectors', async () => {
  await client.callTool({
    name: 'bb_add_cube',
    arguments: { name: 'leg', from: [0, 0, 0], to: [4, 12, 4], origin: [2, 0, 2] },
  });
  const req = mock.received.find((m) => m.method === 'add_cube');
  assert.deepEqual(req.params.from, [0, 0, 0]);
  assert.deepEqual(req.params.to, [4, 12, 4]);
});

test('bb_add_cube rejects malformed vectors (zod validation)', async () => {
  const res = await client.callTool({
    name: 'bb_add_cube',
    arguments: { from: [0, 0], to: [1, 1, 1] }, // from has only 2 elements
  });
  assert.equal(res.isError, true, 'expected a validation error');
});

test('bb_render_view returns an image content block', async () => {
  const res = await client.callTool({ name: 'bb_render_view', arguments: { angle: 'south', width: 128, height: 128 } });
  const image = res.content.find((c) => c.type === 'image');
  assert.ok(image, 'expected an image content block');
  assert.equal(image.mimeType, 'image/png');
  assert.ok(image.data.length > 10);
  const req = mock.received.find((m) => m.method === 'render_view');
  assert.equal(req.params.angle, 'south');
  assert.equal(req.params.width, 128);
});

test('bb_get_texture returns an image content block', async () => {
  const res = await client.callTool({ name: 'bb_get_texture', arguments: {} });
  assert.ok(res.content.find((c) => c.type === 'image'), 'expected image content');
});

test('BridgeClient rejects on a wrong auth token', async () => {
  const badClient = new BridgeClient({ host: '127.0.0.1', port: mock.port, token: 'WRONG', requestTimeoutMs: 5000 });
  await assert.rejects(() => badClient.request('status', {}), /token|auth/i);
  badClient.close();
});

test('BridgeClient authenticates and round-trips with the right token', async () => {
  const goodClient = new BridgeClient({ host: '127.0.0.1', port: mock.port, token: mock.token, requestTimeoutMs: 5000 });
  const res = await goodClient.request('status', {});
  assert.equal(res.app, 'blockbench');
  goodClient.close();
});

test('bb_execute_script forwards code', async () => {
  const res = await client.callTool({ name: 'bb_execute_script', arguments: { code: 'return Cube.all.length;' } });
  assert.equal(res.isError, undefined);
  const req = mock.received.find((m) => m.method === 'execute_script');
  assert.match(req.params.code, /Cube\.all/);
});

test('bb_run_action (universal bridge) forwards id + value', async () => {
  await client.callTool({ name: 'bb_run_action', arguments: { id: 'view_mode', value: 'solid' } });
  const req = mock.received.find((m) => m.method === 'run_action');
  assert.equal(req.params.id, 'view_mode');
  assert.equal(req.params.value, 'solid');
});

test('bb_list_actions is exposed and forwards', async () => {
  const res = await client.callTool({ name: 'bb_list_actions', arguments: { query: 'undo' } });
  assert.equal(res.isError, undefined);
  assert.ok(mock.received.some((m) => m.method === 'list_actions'));
});
