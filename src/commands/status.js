/**
 * `krafto status` — is the agent running here, is the gateway connected, and
 * which sessions have live dev servers. Reads .krafto/config.json +
 * daemon.json only — never talks to the network. Always exits 0: status
 * reports state, it doesn't judge it; machines consume `--json`.
 */

import { isPidAlive, readDaemonState } from '../daemonState.js';
import { c, emitJson, info, isJsonMode, step } from '../ui.js';
import * as util from '../util.js';

export async function runStatus(cwd) {
	let config = null;
	try {
		config = util.readConfig(cwd);
	} catch {
		/* not initialized */
	}

	const state = readDaemonState(cwd);
	const running = Boolean(state?.pid && isPidAlive(state.pid));
	// Group labels are 'project' + raw session ids (see sessions.js trackGroup).
	const sessions = running
		? Object.keys(state.groups ?? {}).filter((label) => label !== 'project')
		: [];

	if (isJsonMode()) {
		emitJson({
			ok: true,
			initialized: Boolean(config),
			running,
			pid: running ? state.pid : null,
			gateway: running ? (state.gateway ?? 'unknown') : null,
			startedAt: running ? (state.startedAt ?? null) : null,
			agentId: config?.agentId ?? null,
			devPort: config?.devPort ?? null,
			sessions
		});
		return;
	}

	if (!config) {
		info(`this project is not connected — run ${c.cyan('npx krafto init')} first`);
		return;
	}
	if (!running) {
		info(`agent is not running — start it with ${c.cyan('npx krafto dev --detach')}`);
		return;
	}
	info(`agent is running (pid ${state.pid})`);
	step(`gateway     ${state.gateway === 'online' ? c.green('online') : state.gateway ?? 'unknown'}`);
	step(`dev port    ${config.devPort}`);
	step(`sessions    ${sessions.length === 0 ? 'none live' : sessions.join(', ')}`);
	if (state.startedAt) step(`started at  ${state.startedAt}`);
}
