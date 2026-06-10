/**
 * `krafto stop` — stop the background agent started by `krafto dev --detach`
 * (works on a foreground daemon too). SIGTERM to the daemon pid is enough:
 * its exit handler takes the session and project dev servers down with it and
 * removes daemon.json. Dead leftovers (SIGKILL/crash) are reaped instead.
 */

import { isPidAlive, readDaemonState, reapOrphans } from '../daemonState.js';
import { emitJson, error, info, isJsonMode, step } from '../ui.js';

const STOP_TIMEOUT_MS = 15_000;

export async function runStop(cwd) {
	const state = readDaemonState(cwd);
	if (!state?.pid || !isPidAlive(state.pid)) {
		const reaped = reapOrphans(cwd);
		info('agent is not running');
		if (reaped.length > 0) step(`cleaned up ${reaped.length} leftover dev server(s)`);
		if (isJsonMode()) emitJson({ ok: true, stopped: false, reaped: reaped.length });
		return;
	}

	process.kill(state.pid, 'SIGTERM');
	const deadline = Date.now() + STOP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!isPidAlive(state.pid)) {
			info(`agent stopped (pid ${state.pid})`);
			if (isJsonMode()) emitJson({ ok: true, stopped: true, pid: state.pid });
			return;
		}
		await sleep(250);
	}
	error(`agent (pid ${state.pid}) did not exit within ${STOP_TIMEOUT_MS / 1000}s`);
	if (isJsonMode()) emitJson({ ok: false, error: 'agent did not exit', pid: state.pid });
	process.exit(1);
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
