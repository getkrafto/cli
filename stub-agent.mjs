#!/usr/bin/env node
/**
 * krafto stub agent — test harness for the gateway proxy spike.
 *
 * WSS client that registers with the gateway (static token) and forwards
 * proxied HTTP requests / WS tunnels to a local dev server. NOT throwaway:
 * this grows into the real `npx krafto dev` daemon (spawn/attach + ts-morph
 * edits come later).
 *
 * Usage:
 *   KRAFTO_PROJECT_TOKEN=dev-token node stub-agent.mjs
 *
 * Env:
 *   KRAFTO_PROJECT_TOKEN  required; must match the gateway's KRAFTO_STATIC_TOKEN
 *   KRAFTO_GATEWAY        default ws://localhost:8787/agent
 *   KRAFTO_AGENT_ID       default "x"
 *   KRAFTO_DEV_PORT       default 3000
 *
 * Plain Node ≥18 (native fetch), single dep: ws.
 */

import WebSocket from 'ws';

const GATEWAY = process.env.KRAFTO_GATEWAY ?? 'ws://localhost:8787/agent';
const TOKEN = process.env.KRAFTO_PROJECT_TOKEN;
const AGENT_ID = process.env.KRAFTO_AGENT_ID ?? 'x';
const DEV_PORT = Number(process.env.KRAFTO_DEV_PORT ?? 3000);
const VERSION = '0.0.0-stub';

if (!TOKEN) {
  console.error('[agent] KRAFTO_PROJECT_TOKEN env var is required');
  process.exit(1);
}

const httpBase = `http://localhost:${DEV_PORT}`;
const wsBase = `ws://localhost:${DEV_PORT}`;

// channelId → { ws, queue } — queue holds frames until the local WS opens.
const channels = new Map();

// fetch already decompressed the body / we re-buffer it: these would now lie.
const RESPONSE_DROP = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);
const REQUEST_DROP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

const ws = new WebSocket(GATEWAY);
const send = (msg) => ws.send(JSON.stringify(msg));

ws.on('open', () => {
  send({ type: 'register', agentId: AGENT_ID, projectToken: TOKEN, version: VERSION });
  setInterval(() => send({ type: 'heartbeat' }), 10_000);
});

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    console.error('[agent] unparseable message from gateway, ignoring');
    return;
  }
  switch (msg.type) {
    case 'registered':
      console.log(`[agent] registered as "${AGENT_ID}", proxying ${httpBase}`);
      return;
    case 'http_request':
      return void handleHttp(msg);
    case 'ws_open':
      return openChannel(msg);
    case 'ws_data': {
      const ch = channels.get(msg.channelId);
      if (!ch) return;
      const payload = msg.binary ? Buffer.from(msg.data, 'base64') : msg.data;
      if (ch.queue) ch.queue.push(payload);
      else ch.ws.send(payload);
      return;
    }
    case 'ws_close': {
      const ch = channels.get(msg.channelId);
      if (!ch) return;
      channels.delete(msg.channelId); // delete first: local close handler must not echo back
      ch.ws.close(safeCloseCode(msg.code), msg.reason ?? '');
      return;
    }
    default:
      console.error(`[agent] unhandled message type "${msg.type}" (stub agent)`);
  }
});

ws.on('close', (code, reason) => {
  console.error(`[agent] gateway closed the connection (${code}${reason?.length ? `: ${reason}` : ''})`);
  process.exit(1); // fail loud, no reconnect in the PoC
});

ws.on('error', (err) => {
  console.error(`[agent] gateway connection error: ${err.message}`);
  process.exit(1);
});

async function handleHttp(msg) {
  try {
    const headers = {};
    for (const [key, value] of Object.entries(msg.headers)) {
      if (!REQUEST_DROP.has(key.toLowerCase())) headers[key] = value;
    }
    const res = await fetch(httpBase + msg.path, {
      method: msg.method,
      headers,
      body: msg.body ? Buffer.from(msg.body, 'base64') : undefined,
      redirect: 'manual', // pass 3xx through to the browser untouched
    });
    const body = Buffer.from(await res.arrayBuffer());
    const outHeaders = {};
    for (const [key, value] of res.headers) {
      if (!RESPONSE_DROP.has(key)) outHeaders[key] = value; // fetch lowercases keys
    }
    send({
      type: 'http_response',
      id: msg.id,
      status: res.status,
      headers: outHeaders,
      body: body.length > 0 ? body.toString('base64') : undefined,
    });
  } catch (err) {
    console.error(`[agent] ${msg.method} ${msg.path} → ${err.message}`);
    send({
      type: 'http_response',
      id: msg.id,
      status: 502,
      headers: { 'content-type': 'text/plain' },
      body: Buffer.from(`krafto agent: dev server unreachable at ${httpBase} (${err.message})`).toString('base64'),
    });
  }
}

function openChannel(msg) {
  const target = new WebSocket(wsBase + msg.path, msg.protocols ?? []);
  const ch = { ws: target, queue: [] };
  channels.set(msg.channelId, ch);

  target.on('open', () => {
    send({ type: 'ws_opened', channelId: msg.channelId, protocol: target.protocol || undefined });
    for (const frame of ch.queue) target.send(frame);
    ch.queue = null;
  });
  target.on('message', (data, isBinary) => {
    send({
      type: 'ws_data',
      channelId: msg.channelId,
      data: isBinary ? Buffer.from(data).toString('base64') : data.toString(),
      binary: isBinary,
    });
  });
  target.on('close', (code, reason) => {
    if (!channels.delete(msg.channelId)) return; // closed from the gateway side
    send({ type: 'ws_close', channelId: msg.channelId, code: safeCloseCode(code), reason: reason.toString().slice(0, 100) });
  });
  target.on('error', (err) => {
    console.error(`[agent] ws ${msg.path} → ${err.message}`);
    // 'close' fires after 'error' and reports the failure upstream
  });
}

/** ws rejects reserved close codes (1005/1006/1015…). */
function safeCloseCode(code) {
  if (code === undefined || code === null) return 1000;
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  return 1000;
}
