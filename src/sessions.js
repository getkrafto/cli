/**
 * Session orchestration for the agent daemon.
 *
 * A session is a shared design draft: branch `krafto/<id>` checked out as a
 * git worktree under .krafto/worktrees/<id>, with its own dev server on its
 * own port. Edits only ever touch session worktrees — the dev's working tree
 * and branches stay untouched (see poc.md decision log "Сессии", 2026-06-05).
 *
 * Driven by `session_ensure` from the gateway; replies with `session_status`
 * (starting → ready|error).
 */

import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { trackGroup, untrackGroup } from './daemonState.js';
import { error, info, step } from './ui.js';
import * as util from './util.js';

const SESSION_READY_TIMEOUT_MS = 60_000;
const LOG_TAIL_LINES = 25;
// Idle reaping: a session dev server eats ~0.5GB RAM and real CPU; with tens
// of sessions per project they pile up fast. A session with no open tunnel
// channels (= no iframe looking at it) and no traffic for this long gets its
// dev server stopped. The worktree and branch stay — the next editor open
// re-ensures it in seconds.
const SESSION_IDLE_MS = Number(process.env.KRAFTO_SESSION_IDLE_MS) || 10 * 60_000;

export function createSessionManager({ cwd, config, send }) {
	const entries = new Map(); // sessionId → { status, port, dir, child, logTail, lastUsed, channels }

	const reaper = setInterval(reapIdle, Math.min(30_000, Math.max(1_000, SESSION_IDLE_MS / 3)));
	reaper.unref(); // never keep the daemon alive just to reap

	function reapIdle() {
		const now = Date.now();
		if (process.env.KRAFTO_DEBUG) {
			for (const [id, e] of entries) {
				console.error(
					`[krafto debug] session ${id}: status=${e.status} channels=${e.channels} idleMs=${now - e.lastUsed}`
				);
			}
		}
		for (const [sessionId, entry] of entries) {
			if (entry.status !== 'ready') continue; // never touch starting ones
			if (entry.channels > 0) continue; // an open tunnel = an iframe is watching
			if (now - entry.lastUsed < SESSION_IDLE_MS) continue;
			entry.status = 'stopped';
			entries.delete(sessionId);
			if (entry.child) killTree(entry.child);
			untrackGroup(sessionId);
			step(`session ${sessionId} idle — dev server stopped (reopens on next editor visit)`);
			// Editors with the page still open learn the session paused and can
			// revive it (the next edit or editor connect re-ensures).
			status(sessionId, { status: 'stopped' });
		}
	}

	/** Activity ping from proxied HTTP / edits — postpones idle reaping. */
	function touch(sessionId) {
		const entry = entries.get(sessionId);
		if (entry) entry.lastUsed = Date.now();
	}

	/** Open WS tunnels (HMR etc.) pin the session as active while the iframe lives. */
	function channelOpened(sessionId) {
		const entry = entries.get(sessionId);
		if (process.env.KRAFTO_DEBUG) {
			console.error(`[krafto debug] channelOpened ${sessionId} → ${entry ? entry.channels + 1 : 'no entry'}`);
		}
		if (!entry) return;
		entry.channels++;
		entry.lastUsed = Date.now();
	}

	function channelClosed(sessionId) {
		const entry = entries.get(sessionId);
		if (process.env.KRAFTO_DEBUG) {
			console.error(`[krafto debug] channelClosed ${sessionId} → ${entry ? entry.channels - 1 : 'no entry'}`);
		}
		if (!entry) return;
		entry.channels = Math.max(0, entry.channels - 1);
		entry.lastUsed = Date.now(); // grace period starts when the last tab leaves
	}

	function git(args, opts = {}) {
		return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], ...opts })
			.toString()
			.trim();
	}

	function status(sessionId, payload) {
		send({ type: 'session_status', sessionId, ...payload });
	}

	/** Idempotent: a re-ensure of a live session just re-reports ready. */
	async function ensure(msg) {
		const { sessionId, branch } = msg;
		const existing = entries.get(sessionId);
		if (existing) {
			if (existing.status === 'ready') return status(sessionId, { status: 'ready', port: existing.port });
			if (existing.status === 'starting') return; // first ensure will report when done
			entries.delete(sessionId); // status 'error' → retry from scratch
		}

		const entry = {
			status: 'starting',
			port: null,
			dir: null,
			child: null,
			logTail: [],
			lastUsed: Date.now(),
			channels: 0
		};
		entries.set(sessionId, entry);
		status(sessionId, { status: 'starting' });

		try {
			const { dir, baseCommit } = ensureWorktree(
				sessionId,
				branch,
				msg.baseCommit ?? null,
				msg.forkFromBranch ?? null
			);
			entry.dir = dir;
			ensureNodeModules(dir);
			copyEnvFiles(dir);

			const port = await freePort();
			entry.port = port;
			spawnDevServer(entry, sessionId, dir, port);

			const deadline = Date.now() + SESSION_READY_TIMEOUT_MS;
			while (Date.now() < deadline) {
				if (entry.status === 'error') return; // child exited while we waited
				if (await util.isPortListening(port)) {
					entry.status = 'ready';
					step(`session ${sessionId} ready on :${port} (${branch})`);
					return status(sessionId, { status: 'ready', port, ...(baseCommit ? { baseCommit } : {}) });
				}
				await sleep(500);
			}
			throw new Error(`dev server didn't come up on :${port} within 60s`);
		} catch (err) {
			entry.status = 'error';
			if (entry.child) killTree(entry.child);
			const tail = entry.logTail.length ? `\n${entry.logTail.join('\n')}` : '';
			error(`session ${sessionId} failed: ${err.message}${tail}`);
			status(sessionId, { status: 'error', error: String(err.message).slice(0, 500) });
		}
	}

	/**
	 * Create (or reuse) the worktree for the session branch. Returns baseCommit
	 * only when the branch was created right now — that is what the session was
	 * actually forked from, and the gateway records it.
	 */
	function ensureWorktree(sessionId, branch, requestedBase, forkFromBranch) {
		if (!util.isGitRepo(cwd)) throw new Error('not a git repository — sessions need git');
		// Worktrees live inside the repo — keep them out of `git status` without
		// touching the user's .gitignore.
		util.excludeFromGitStatus(cwd, ['.krafto/worktrees/', '.krafto/daemon.json']);
		git(['worktree', 'prune']); // drop stale registrations (deleted dirs)

		const dir = join(cwd, '.krafto', 'worktrees', sessionId);
		if (existsSync(join(dir, '.git'))) return { dir, baseCommit: null }; // alive from a previous run

		mkdirSync(join(cwd, '.krafto', 'worktrees'), { recursive: true });
		if (branchExists(branch)) {
			// Branch survives daemon restarts and dir cleanups — re-attach to it.
			git(['worktree', 'add', dir, branch]);
			return { dir, baseCommit: null };
		}
		// Fork point: explicit > parent session's branch head (fork) > project HEAD.
		const base =
			requestedBase ||
			(forkFromBranch && branchExists(forkFromBranch)
				? git(['rev-parse', forkFromBranch])
				: git(['rev-parse', 'HEAD']));
		git(['worktree', 'add', '-b', branch, dir, base]);
		return { dir, baseCommit: base };
	}

	function branchExists(branch) {
		try {
			git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Per-worktree node_modules via copy-on-write clone: instant on APFS/btrfs/xfs,
	 * and it keeps Vite's cache (node_modules/.vite) isolated per session — two
	 * dev servers sharing one cache corrupt each other. Symlink is the last-resort
	 * fallback (plain ext4): fast, but with the shared-Vite-cache caveat.
	 */
	function ensureNodeModules(dir) {
		const src = join(cwd, 'node_modules');
		const dest = join(dir, 'node_modules');
		if (!existsSync(src) || existsSync(dest)) return;
		try {
			if (process.platform === 'darwin') {
				execFileSync('cp', ['-Rc', src, dest], { stdio: 'ignore' });
			} else {
				execFileSync('cp', ['-a', '--reflink=always', src, dest], { stdio: 'ignore' });
			}
		} catch {
			info('copy-on-write clone unavailable — symlinking node_modules (Vite cache is shared)');
			execFileSync('ln', ['-s', src, dest], { stdio: 'ignore' });
		}
	}

	/** Gitignored .env* files don't travel with the branch — copy them over. */
	function copyEnvFiles(dir) {
		for (const name of readdirSync(cwd)) {
			if (!name.startsWith('.env')) continue;
			const from = join(cwd, name);
			const to = join(dir, name);
			if (!existsSync(to)) copyFileSync(from, to);
		}
	}

	function spawnDevServer(entry, sessionId, dir, port) {
		// Port override goes through `<pm> run dev -- <flags>` so the user's own
		// dev script (turbopack flags etc.) keeps working; a later flag wins over
		// one hardcoded in the script.
		const portArgs =
			config.framework === 'next' ? ['-p', String(port)] : ['--port', String(port), '--strictPort'];
		// detached: own process group — killing only `<pm> run dev` orphans the
		// actual server (its grandchild), which keeps squatting the port.
		// Teardown signals the whole group (killTree).
		const child = spawn(config.packageManager, ['run', 'dev', '--', ...portArgs], {
			cwd: dir,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: process.env,
			detached: true
		});
		entry.child = child;
		trackGroup(sessionId, child.pid); // reaped by the next `krafto dev` if we die hard

		// Don't stream session dev-server output (several at once would flood the
		// terminal) — keep a tail to print when something goes wrong.
		const keepTail = (chunk) => {
			entry.logTail.push(...chunk.toString().split('\n').filter(Boolean));
			if (entry.logTail.length > LOG_TAIL_LINES) {
				entry.logTail.splice(0, entry.logTail.length - LOG_TAIL_LINES);
			}
		};
		child.stdout.on('data', keepTail);
		child.stderr.on('data', keepTail);

		child.on('exit', (code) => {
			untrackGroup(sessionId);
			if (entry.status === 'stopped') return;
			const wasReady = entry.status === 'ready';
			entry.status = 'error';
			if (wasReady) {
				error(`session ${sessionId} dev server exited (${code})`);
				status(sessionId, { status: 'error', error: `dev server exited (${code})` });
			}
			// While starting: ensure() is still polling, it reports the failure.
		});
	}

	function portFor(sessionId) {
		const entry = entries.get(sessionId);
		if (entry?.status !== 'ready') return null;
		entry.lastUsed = Date.now();
		return entry.port;
	}

	function dirFor(sessionId) {
		const entry = entries.get(sessionId);
		return entry && entry.status !== 'error' ? entry.dir : null;
	}

	/**
	 * Worktree of a session that is not currently running (idle-reaped or
	 * daemon restarted). Edits can be applied there directly — the worktree
	 * and branch outlive the dev server by design.
	 */
	function dormantDirFor(sessionId) {
		const dir = join(cwd, '.krafto', 'worktrees', sessionId);
		return existsSync(join(dir, '.git')) ? dir : null;
	}

	/** Bring a reaped session back. Branch name is the krafto/<id> convention. */
	function revive(sessionId) {
		void ensure({
			type: 'session_ensure',
			sessionId,
			branch: `krafto/${sessionId}`,
			baseCommit: null
		});
	}

	function shutdown() {
		clearInterval(reaper);
		for (const entry of entries.values()) {
			entry.status = 'stopped';
			if (entry.child) killTree(entry.child);
		}
		entries.clear();
	}

	return {
		ensure,
		portFor,
		dirFor,
		dormantDirFor,
		revive,
		touch,
		channelOpened,
		channelClosed,
		shutdown
	};
}

/** Kill the dev server's whole process group, not just the `<pm> run` wrapper. */
export function killTree(child, signal = 'SIGTERM') {
	try {
		process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

function freePort() {
	return new Promise((resolve, reject) => {
		const srv = net.createServer();
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address();
			srv.close(() => resolve(port));
		});
		srv.on('error', reject);
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
