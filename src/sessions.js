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
import { copyFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { error, info, step } from './ui.js';
import * as util from './util.js';

const SESSION_READY_TIMEOUT_MS = 60_000;
const LOG_TAIL_LINES = 25;

export function createSessionManager({ cwd, config, send }) {
	const entries = new Map(); // sessionId → { status, port, dir, child, logTail }

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

		const entry = { status: 'starting', port: null, dir: null, child: null, logTail: [] };
		entries.set(sessionId, entry);
		status(sessionId, { status: 'starting' });

		try {
			const { dir, baseCommit } = ensureWorktree(sessionId, branch, msg.baseCommit ?? null);
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
			if (entry.child) entry.child.kill('SIGTERM');
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
	function ensureWorktree(sessionId, branch, requestedBase) {
		if (!util.isGitRepo(cwd)) throw new Error('not a git repository — sessions need git');
		excludeWorktreesFromGit();
		git(['worktree', 'prune']); // drop stale registrations (deleted dirs)

		const dir = join(cwd, '.krafto', 'worktrees', sessionId);
		if (existsSync(join(dir, '.git'))) return { dir, baseCommit: null }; // alive from a previous run

		mkdirSync(join(cwd, '.krafto', 'worktrees'), { recursive: true });
		if (branchExists(branch)) {
			// Branch survives daemon restarts and dir cleanups — re-attach to it.
			git(['worktree', 'add', dir, branch]);
			return { dir, baseCommit: null };
		}
		const base = requestedBase || git(['rev-parse', 'HEAD']);
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
	 * Worktrees live inside the repo — keep them out of `git status` without
	 * touching the user's .gitignore: .git/info/exclude is repo-local and
	 * invisible to the user's tree.
	 */
	function excludeWorktreesFromGit() {
		try {
			const gitDir = git(['rev-parse', '--git-common-dir']);
			const excludePath = join(gitDir.startsWith('/') ? gitDir : join(cwd, gitDir), 'info', 'exclude');
			const line = '.krafto/worktrees/';
			const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
			if (current.split('\n').some((l) => l.trim() === line)) return;
			appendFileSync(excludePath, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
		} catch {
			// Cosmetic only — worst case `git status` shows the worktrees dir.
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
		const child = spawn(config.packageManager, ['run', 'dev', '--', ...portArgs], {
			cwd: dir,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: process.env
		});
		entry.child = child;

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
		return entry?.status === 'ready' ? entry.port : null;
	}

	function dirFor(sessionId) {
		const entry = entries.get(sessionId);
		return entry && entry.status !== 'error' ? entry.dir : null;
	}

	function shutdown() {
		for (const entry of entries.values()) {
			entry.status = 'stopped';
			if (entry.child) entry.child.kill('SIGTERM');
		}
		entries.clear();
	}

	return { ensure, portFor, dirFor, shutdown };
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
