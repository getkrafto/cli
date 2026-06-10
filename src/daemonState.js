/**
 * Daemon process bookkeeping: .krafto/daemon.json records the daemon pid and
 * the process groups of every dev server it spawned (project + sessions).
 *
 * Why: the 'exit' handler covers Ctrl-C/SIGTERM/SIGHUP and fail-loud exits,
 * but not SIGKILL or a hard crash — those orphan detached dev servers that
 * keep burning CPU/RAM invisibly. The next `krafto dev` reads the leftover
 * state and reaps them before starting.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

let current = null;
let currentCwd = null;

function statePath(cwd) {
	return join(cwd, '.krafto', 'daemon.json');
}

function save() {
	mkdirSync(join(currentCwd, '.krafto'), { recursive: true });
	writeFileSync(statePath(currentCwd), `${JSON.stringify(current, null, 2)}\n`);
}

export function initDaemonState(cwd, meta = {}) {
	currentCwd = cwd;
	current = { pid: process.pid, startedAt: new Date().toISOString(), gateway: 'connecting', ...meta, groups: {} };
	save();
}

/** Record gateway connection progress ('connecting' → 'online') for `krafto status`. */
export function setGatewayState(state) {
	if (!current) return;
	current.gateway = state;
	save();
}

/** Read another process's daemon.json (for `status`/`stop`). Null when absent/corrupt. */
export function readDaemonState(cwd) {
	try {
		return JSON.parse(readFileSync(statePath(cwd), 'utf8'));
	} catch {
		return null;
	}
}

export function isPidAlive(pid) {
	return isAlive(pid);
}

/** Register a spawned dev server's process group (child is its group leader). */
export function trackGroup(label, pid) {
	if (!current) return; // not inited (e.g. test harness drives the manager directly)
	current.groups[label] = pid;
	save();
}

export function untrackGroup(label) {
	if (!current || !(label in current.groups)) return;
	delete current.groups[label];
	save();
}

/** Clean-exit path: everything was killed, leave nothing to reap. */
export function clearDaemonState() {
	if (!currentCwd) return;
	try {
		rmSync(statePath(currentCwd));
	} catch {
		/* already gone */
	}
}

/**
 * Kill dev-server groups left behind by a daemon that died without cleanup
 * (SIGKILL, crash, power loss). Call at startup, BEFORE probing devPort —
 * an orphaned project server would otherwise get attached to as if healthy.
 * Returns the labels it reaped.
 */
export function reapOrphans(cwd) {
	let prev;
	try {
		prev = JSON.parse(readFileSync(statePath(cwd), 'utf8'));
	} catch {
		return [];
	}
	// A live recorded pid means another daemon is running here (or its pid got
	// reused) — don't touch anything we can't be sure about.
	if (prev.pid && isAlive(prev.pid)) return [];

	const reaped = [];
	for (const [label, pgid] of Object.entries(prev.groups ?? {})) {
		if (!groupLooksLikeDevServer(pgid)) continue; // pgid reuse guard
		try {
			process.kill(-pgid, 'SIGTERM');
			reaped.push(label);
		} catch {
			/* group already gone */
		}
	}
	try {
		rmSync(statePath(cwd));
	} catch {
		/* fine */
	}
	return reaped;
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Only kill groups whose surviving members still look like a JS dev server. */
function groupLooksLikeDevServer(pgid) {
	try {
		const out = execFileSync('ps', ['-A', '-o', 'pgid=,command='], {
			stdio: ['ignore', 'pipe', 'ignore']
		}).toString();
		return out.split('\n').some((line) => {
			const m = line.trim().match(/^(\d+)\s+(.+)$/);
			return (
				m && Number(m[1]) === pgid && /node|next|vite|npm|pnpm|yarn|bun/.test(m[2])
			);
		});
	} catch {
		return false;
	}
}
