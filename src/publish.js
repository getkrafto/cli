/**
 * Changes panel + Publish: read the session branch's commit log and push it
 * to the project's git remote with the dev's own credentials (git credential
 * helper — the agent stores none; pushing is allowed ONLY here, on an explicit
 * Publish from the editor).
 *
 * Both handlers run against the main checkout (cwd): the session branch is a
 * normal local branch there, so a dormant (idle-reaped) session publishes
 * fine without reviving its dev server.
 */

import { execFile } from 'node:child_process';
import { error, step } from './ui.js';

const PUSH_TIMEOUT_MS = 120_000;
const SEP = '\x1f';

function git(cwd, args, { timeout = 15_000, env } = {}) {
	return new Promise((resolve, reject) => {
		execFile(
			'git',
			args,
			{ cwd, timeout, maxBuffer: 8 * 1024 * 1024, env },
			(err, stdout, stderr) => {
				if (err) {
					// stderr carries the useful part (auth failures, rejected pushes) —
					// keep its tail, that's where remotes put the reason.
					const detail = (stderr?.toString().trim() || err.message).slice(-500);
					reject(new Error(detail));
				} else {
					resolve(stdout.toString().trim());
				}
			}
		);
	});
}

async function branchExists(cwd, branch) {
	try {
		await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
		return true;
	} catch {
		return false;
	}
}

/** Mirrors branchNameSchema in the gateway's protocol.ts — agent-side defense. */
function validBranchName(name) {
	return (
		typeof name === 'string' &&
		name.length > 0 &&
		name.length <= 200 &&
		/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) &&
		!name.includes('..') &&
		!name.includes('//') &&
		!name.endsWith('/') &&
		!name.endsWith('.') &&
		!name.endsWith('.lock')
	);
}

/** `changes_request` → `changes`: session commits not on the base, newest first. */
export async function handleChangesRequest(cwd, send, msg) {
	const reply = (payload) =>
		send({ type: 'changes', requestId: msg.requestId, sessionId: msg.sessionId, ...payload });
	try {
		if (!msg.sessionId) throw new Error('no session on the request');
		const branch = `krafto/${msg.sessionId}`;
		if (!(await branchExists(cwd, branch))) {
			// No branch = no worktree was ever created = nothing edited yet.
			return reply({ ok: true, commits: [] });
		}
		// Fork point: recorded at worktree creation; sessions older than that
		// record fall back to the merge-base with the main checkout.
		const base = msg.baseCommit || (await git(cwd, ['merge-base', 'HEAD', branch]).catch(() => null));
		const out = await git(cwd, [
			'log',
			`--format=%H${SEP}%s${SEP}%an${SEP}%ae${SEP}%at`,
			base ? `${base}..${branch}` : branch
		]);
		const commits = !out
			? []
			: out.split('\n').map((line) => {
					const [sha, subject, authorName, authorEmail, at] = line.split(SEP);
					return { sha, subject, authorName, authorEmail, timestamp: Number(at) || 0 };
				});
		reply({ ok: true, commits });
	} catch (err) {
		error(`changes for session ${msg.sessionId} failed: ${err.message}`);
		reply({ ok: false, error: String(err.message).slice(0, 500) });
	}
}

/** `publish` → `publish_status` (pushing → done|error). */
export async function handlePublish(cwd, send, msg) {
	const branch = `krafto/${msg.sessionId}`;
	const remoteBranch = msg.remoteBranch || branch;
	const reply = (payload) =>
		send({
			type: 'publish_status',
			requestId: msg.requestId,
			sessionId: msg.sessionId,
			remoteBranch,
			...payload
		});
	try {
		if (!msg.sessionId) throw new Error('no session on the request');
		// The gateway validates too — this guards a compromised/old gateway from
		// smuggling git options or refspec tricks through the branch name.
		if (!validBranchName(remoteBranch)) throw new Error('invalid remote branch name');
		if (!(await branchExists(cwd, branch))) {
			throw new Error('session branch does not exist yet — apply an edit first');
		}
		const remotes = (await git(cwd, ['remote'])).split('\n').filter(Boolean);
		if (remotes.length === 0) {
			throw new Error('no git remote configured — add one (e.g. origin) and retry');
		}
		const remote = remotes.includes('origin') ? 'origin' : remotes[0];

		reply({ status: 'pushing' });
		step(`publish: pushing ${branch} → ${remote}/${remoteBranch}`);
		// GIT_TERMINAL_PROMPT=0: with no usable credential helper git must fail
		// loud, not hang the daemon waiting on an invisible password prompt.
		await git(cwd, ['push', remote, `refs/heads/${branch}:refs/heads/${remoteBranch}`], {
			timeout: PUSH_TIMEOUT_MS,
			env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
		});
		step(`publish: pushed ${remote}/${remoteBranch}`);
		reply({ status: 'done' });
	} catch (err) {
		error(`publish failed: ${err.message}`);
		reply({ status: 'error', error: String(err.message).slice(0, 500) });
	}
}
