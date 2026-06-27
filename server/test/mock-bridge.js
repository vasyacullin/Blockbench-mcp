// mock-bridge.js
// A tiny stand-in for the Blockbench plugin's TCP server, used by the smoke test.
// Speaks the same NDJSON protocol and returns canned results so we can verify the
// MCP server end-to-end without launching Blockbench.

import net from 'node:net';

// 1x1 transparent PNG (base64) for image-returning tools.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

export function startMockBridge(token = 'testtoken') {
  return new Promise((resolve) => {
    const received = [];
    const server = net.createServer((socket) => {
      socket.setNoDelay(true);
      socket._authed = false;
      socket.write(JSON.stringify({ type: 'hello', app: 'blockbench', version: '5.1.4', protocol: 1 }) + '\n');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (!line.trim()) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { socket.destroy(); return; }

          if (!socket._authed) {
            if (msg.type === 'auth' && msg.token === token) {
              socket._authed = true;
              socket.write(JSON.stringify({ type: 'auth_ok', protocol: 1 }) + '\n');
            } else {
              socket.write(JSON.stringify({ type: 'auth_err', message: 'bad token' }) + '\n');
              socket.destroy();
            }
            continue;
          }

          if (msg.type !== 'req') continue;
          received.push(msg);
          const result = handle(msg.method, msg.params);
          socket.write(JSON.stringify({ type: 'res', id: msg.id, ok: true, result }) + '\n');
        }
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, received, token });
    });
  });
}

function handle(method, params) {
  switch (method) {
    case 'status':
      return { connected: true, app: 'blockbench', version: '5.1.4', project: { name: 'test', format: 'bedrock' } };
    case 'create_project':
      return { uuid: 'proj-uuid', format: params.format, name: params.name || null };
    case 'add_cube':
      return { uuid: 'cube-uuid', name: params.name || 'cube', echo: params };
    case 'render_view':
      return { data_url: 'data:image/png;base64,' + PNG_1x1, width: params.width || 600, height: params.height || 600, angle: params.angle || 'isometric_right' };
    case 'get_texture':
      return { uuid: 'tex', name: 'tex', width: 16, height: 16, data_url: 'data:image/png;base64,' + PNG_1x1 };
    case 'execute_script':
      return { result: { ran: true, code_len: (params.code || '').length } };
    case 'list_actions':
      return { count: 2, actions: [{ id: 'undo', name: 'Undo', type: 'action', available: true }, { id: 'view_mode', name: 'View Mode', type: 'select', value: 'textured', options: ['textured', 'solid'] }] };
    case 'run_action':
      return { id: params.id, type: 'action', triggered: true, value: params.value };
    case 'select':
      return { selected_elements: [], selected_group: null, selected_texture: null };
    case 'set_setting':
      return { id: params.id, value: params.value };
    default:
      return { method, params, mocked: true };
  }
}
