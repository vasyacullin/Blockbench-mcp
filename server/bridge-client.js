// bridge-client.js
// Thin TCP client that talks the Blockbench MCP Bridge protocol.
//
// Transport: a raw TCP socket carrying newline-delimited JSON ("NDJSON").
// JSON.stringify never emits a literal newline, so splitting incoming bytes on
// "\n" yields exactly one message per line.
//
// Roles: the *Blockbench plugin* is the TCP SERVER (it listens, because there is
// exactly one Blockbench instance and it owns the port). This MCP server is the
// TCP CLIENT: it connects out, retries on failure, and reconnects if dropped.
//
// Wire messages:
//   server -> plugin : {"type":"req","id":<n>,"method":<string>,"params":<object>}
//   plugin -> server : {"type":"res","id":<n>,"ok":true,"result":<any>}
//                    | {"type":"res","id":<n>,"ok":false,"error":{message,stack?}}
//   plugin -> server : {"type":"hello",...}    (informational, on connect)

import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 19888;

export class BridgeClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.host]
   * @param {number} [opts.port]
   * @param {number} [opts.requestTimeoutMs] per-request timeout
   * @param {(msg:string)=>void} [opts.log] logger (must NOT write to stdout for stdio MCP)
   */
  constructor(opts = {}) {
    this.host = opts.host || process.env.BLOCKBENCH_MCP_HOST || DEFAULT_HOST;
    this.port = Number(opts.port || process.env.BLOCKBENCH_MCP_PORT || DEFAULT_PORT);
    this.token = opts.token || process.env.BLOCKBENCH_MCP_TOKEN || '';
    this.requestTimeoutMs = opts.requestTimeoutMs || 30000;
    this.log = opts.log || (() => {});

    /** @type {net.Socket|null} */
    this.socket = null;
    this.connected = false; // true only after a successful auth handshake
    this.connecting = null; // Promise while a connection attempt is in-flight
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.nextId = 1;
    this._resolveConnect = null;
    this._rejectConnect = null;
    /** @type {Map<number,{resolve,reject,timer}>} */
    this.pending = new Map();
    this.hello = null; // last hello payload from the plugin
    this._intentionalClose = false;
  }

  isConnected() {
    return this.connected && this.socket && !this.socket.destroyed;
  }

  /**
   * Ensure a live connection, attempting to (re)connect if needed.
   * Resolves when connected, rejects if the attempt fails.
   */
  connect() {
    if (this.isConnected()) return Promise.resolve();
    if (this.connecting) return this.connecting;

    this._intentionalClose = false;
    this.connecting = new Promise((resolve, reject) => {
      // connect() resolves only once the auth handshake succeeds (auth_ok),
      // so callers never send requests over an unauthenticated socket.
      this._resolveConnect = resolve;
      this._rejectConnect = reject;

      const socket = new net.Socket();
      this.socket = socket;
      this.decoder = new StringDecoder('utf8');
      this.buffer = '';

      const onError = (err) => {
        socket.removeListener('connect', onTcpConnect);
        this._failConnect(err);
      };
      const onTcpConnect = () => {
        socket.removeListener('error', onError);
        socket.on('error', (e) => this.log('socket error: ' + e.message));
        this.log(`TCP connected to ${this.host}:${this.port}; authenticating…`);
        // Send the auth handshake as the very first line.
        try {
          socket.write(JSON.stringify({ type: 'auth', token: this.token }) + '\n', 'utf8');
        } catch (e) {
          this._failConnect(e);
        }
      };

      socket.once('error', onError);
      socket.once('connect', onTcpConnect);
      socket.setNoDelay(true);
      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('close', () => this._onClose());

      socket.connect(this.port, this.host);
    });
    return this.connecting;
  }

  _failConnect(err) {
    this.connecting = null;
    this.connected = false;
    const reject = this._rejectConnect;
    this._resolveConnect = this._rejectConnect = null;
    if (reject) reject(err);
  }

  _onData(chunk) {
    this.buffer += this.decoder.write(chunk);
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        this.log('failed to parse message: ' + err.message);
        continue;
      }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    if (msg.type === 'hello') {
      this.hello = msg;
      this.log(`bridge hello: Blockbench ${msg.version || '?'} (protocol ${msg.protocol})`);
      return;
    }
    if (msg.type === 'auth_ok') {
      this.connected = true;
      this.connecting = null;
      const resolve = this._resolveConnect;
      this._resolveConnect = this._rejectConnect = null;
      this.log(`authenticated; bridge ready at ${this.host}:${this.port}`);
      if (resolve) resolve();
      return;
    }
    if (msg.type === 'auth_err') {
      const err = new Error(msg.message || 'Bridge authentication failed (check BLOCKBENCH_MCP_TOKEN).');
      this._failConnect(err);
      try { this.socket?.destroy(); } catch {}
      return;
    }
    if (msg.type === 'res' && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.ok) {
        resolve(msg.result);
      } else {
        const err = new Error(msg.error?.message || 'Bridge error');
        err.bridgeStack = msg.error?.stack;
        reject(err);
      }
    }
  }

  _onClose() {
    this.connected = false;
    // Reject all in-flight requests so callers don't hang.
    for (const [id, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error('Connection to Blockbench closed before response'));
      this.pending.delete(id);
    }
    // If the socket closed mid-handshake, fail the pending connect().
    if (this._rejectConnect) {
      this._failConnect(new Error('Connection to Blockbench closed before authentication completed'));
    }
    if (!this._intentionalClose) {
      this.log('connection to Blockbench bridge closed');
    }
  }

  /**
   * Send a request and await its result. Auto-connects first.
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  async request(method, params = {}) {
    if (!this.isConnected()) {
      await this.connect();
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ type: 'req', id, method, params }) + '\n';

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Bridge request "${method}" timed out after ${this.requestTimeoutMs}ms`));
        }
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      this.socket.write(payload, 'utf8', (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  close() {
    this._intentionalClose = true;
    if (this.socket) {
      try { this.socket.destroy(); } catch {}
    }
  }
}

export { DEFAULT_HOST, DEFAULT_PORT };
