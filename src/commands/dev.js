/**
 * `krafto dev` — the agent daemon.
 *
 * Reads .krafto/config.json + secrets.env, attaches to (or spawns) the dev
 * server, opens a WSS to the gateway, registers with the project token, and
 * tunnels proxied HTTP/WS to the local dev server. Grown from stub-agent.mjs.
 *
 * Sessions (session_ensure): each session gets a git worktree on branch
 * krafto/<id> with its own dev server — see ../sessions.js. Proxied traffic
 * carrying a sessionId routes to that session's port.
 *
 * Edits (type:'edit') are the editing layer — logged but not yet applied.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createSessionManager } from '../sessions.js';
import { error, info, step } from '../ui.js';
import * as util from '../util.js';

const HEARTBEAT_MS = 10_000;
const DEV_READY_TIMEOUT_MS = 60_000;

// Headers that would lie after fetch re-buffers/decodes the body.
const RESPONSE_DROP = new Set([
	'content-encoding',
	'content-length',
	'transfer-encoding',
	'connection',
	'keep-alive'
]);
const REQUEST_DROP = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

export async function runDev(cwd) {
	let config;
	let secrets;
	try {
		config = util.readConfig(cwd);
		secrets = util.readSecrets(cwd);
	} catch {
		error('no .krafto/config.json here — run `krafto init` first');
		process.exit(1);
	}
	const token = secrets.KRAFTO_PROJECT_TOKEN;
	if (!token) {
		error('.krafto/secrets.env is missing KRAFTO_PROJECT_TOKEN — re-run `krafto init`');
		process.exit(1);
	}

	const child = await ensureDevServer(cwd, config);
	const { ws, sessions } = connect(cwd, config, token);

	// Ctrl-C: stop the daemon, session dev servers, and the project dev server
	// we spawned (if any).
	const shutdown = () => {
		try {
			ws.close();
		} catch {
			/* already closing */
		}
		sessions.shutdown();
		if (child) child.kill('SIGTERM');
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

/** Attach to a dev server already on devPort, otherwise spawn `<pm> run dev`. */
async function ensureDevServer(cwd, config) {
	if (await util.isPortListening(config.devPort)) {
		info(`attached to the dev server already on :${config.devPort}`);
		return null;
	}
	info(`starting dev server: ${config.packageManager} run dev`);
	const child = spawn(config.packageManager, ['run', 'dev'], {
		cwd,
		stdio: 'inherit',
		env: process.env
	});
	child.on('exit', (code) => {
		error(`dev server exited (${code}) — shutting down`);
		process.exit(1);
	});

	const deadline = Date.now() + DEV_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await util.isPortListening(config.devPort)) {
			step(`dev server is up on :${config.devPort}`);
			return child;
		}
		await sleep(500);
	}
	error(`dev server didn't come up on :${config.devPort} within 60s`);
	child.kill('SIGTERM');
	process.exit(1);
}

function connect(cwd, config, token) {
	const version = readVersion();
	const channels = new Map(); // channelId → { ws, queue }

	const ws = new WebSocket(config.gateway.replace(/\/agent$/, '') + '/agent');
	const send = (msg) => ws.send(JSON.stringify(msg));
	const sessions = createSessionManager({ cwd, config, send });
	// Traffic without a sessionId goes to the project's own dev server; with one,
	// to that session's dev server (null until session_ensure reported ready).
	const portOf = (msg) => (msg.sessionId ? sessions.portFor(msg.sessionId) : config.devPort);
	let heartbeat;

	ws.on('open', () => {
		send({ type: 'register', agentId: config.agentId, projectToken: token, version });
		heartbeat = setInterval(() => send({ type: 'heartbeat' }), HEARTBEAT_MS);
	});

	ws.on('message', (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return;
		}
		switch (msg.type) {
			case 'registered':
				info(
					`agent online — proxying http://localhost:${config.devPort}. Open the editor from your dashboard.`
				);
				return;
			case 'session_ensure':
				return void sessions.ensure(msg);
			case 'http_request': {
				const port = portOf(msg);
				if (!port) return sendUnready(send, msg);
				return void handleHttp(send, `http://localhost:${port}`, msg);
			}
			case 'ws_open': {
				const port = portOf(msg);
				if (!port) {
					// Gateway is expected to ensure the session before proxying into it.
					return send({
						type: 'ws_close',
						channelId: msg.channelId,
						code: 1000,
						reason: 'session not ready'
					});
				}
				return openChannel(send, `ws://localhost:${port}`, channels, msg);
			}
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
				channels.delete(msg.channelId);
				ch.ws.close(safeCloseCode(msg.code), msg.reason ?? '');
				return;
			}
			case 'edit':
				// Editing layer (week 3): grep data-krafto-id → ts-morph → write file.
				step(`edit ${msg.editId} received (apply lands with the editing layer)`);
				return;
			default:
				return;
		}
	});

	ws.on('close', (code, reason) => {
		clearInterval(heartbeat);
		const why = reason?.length ? `: ${reason}` : '';
		error(`gateway closed the connection (${code}${why})`);
		process.exit(1); // fail loud, no reconnect in the PoC
	});
	ws.on('error', (err) => {
		error(`gateway connection error: ${err.message}`);
		process.exit(1);
	});

	return ws;
}

function sendUnready(send, msg) {
	send({
		type: 'http_response',
		id: msg.id,
		status: 503,
		headers: { 'content-type': 'text/plain', 'retry-after': '2' },
		body: Buffer.from('krafto agent: session dev server is not ready yet').toString('base64')
	});
}

async function handleHttp(send, httpBase, msg) {
	try {
		const headers = {};
		for (const [key, value] of Object.entries(msg.headers)) {
			if (!REQUEST_DROP.has(key.toLowerCase())) headers[key] = value;
		}
		const res = await fetch(httpBase + msg.path, {
			method: msg.method,
			headers,
			body: msg.body ? Buffer.from(msg.body, 'base64') : undefined,
			redirect: 'manual'
		});
		const body = Buffer.from(await res.arrayBuffer());
		const outHeaders = {};
		for (const [key, value] of res.headers) {
			if (!RESPONSE_DROP.has(key)) outHeaders[key] = value;
		}
		send({
			type: 'http_response',
			id: msg.id,
			status: res.status,
			headers: outHeaders,
			body: body.length > 0 ? body.toString('base64') : undefined
		});
	} catch (err) {
		send({
			type: 'http_response',
			id: msg.id,
			status: 502,
			headers: { 'content-type': 'text/plain' },
			body: Buffer.from(`krafto agent: dev server unreachable (${err.message})`).toString('base64')
		});
	}
}

function openChannel(send, wsBase, channels, msg) {
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
			binary: isBinary
		});
	});
	target.on('close', (code, reason) => {
		if (!channels.delete(msg.channelId)) return;
		send({
			type: 'ws_close',
			channelId: msg.channelId,
			code: safeCloseCode(code),
			reason: reason.toString().slice(0, 100)
		});
	});
	target.on('error', () => {
		// 'close' fires after 'error' and reports the failure upstream
	});
}

function safeCloseCode(code) {
	if (code === undefined || code === null) return 1000;
	if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
	return 1000;
}

function readVersion() {
	const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
	return JSON.parse(readFileSync(pkg, 'utf8')).version;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
