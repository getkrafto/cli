/** Shared helpers for init/dev: prompts, git, browser, .krafto files. No deps. */

import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';

// --- prompts ---------------------------------------------------------------

export async function prompt(question, def) {
	// Non-interactive (CI / piped / SSH without a TTY): take the default, no hang.
	if (!process.stdin.isTTY) return def ?? '';
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(`${question}${def ? ` (${def})` : ''}: `)).trim();
		return answer || def || '';
	} finally {
		rl.close();
	}
}

export async function confirm(question, def = true) {
	if (!process.stdin.isTTY) return def;
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(`${question} ${def ? '(Y/n)' : '(y/N)'}: `)).trim().toLowerCase();
		if (!answer) return def;
		return answer === 'y' || answer === 'yes';
	} finally {
		rl.close();
	}
}

// --- git -------------------------------------------------------------------

function git(cwd, args) {
	return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

// Untrimmed variant: porcelain status lines start with a significant space for
// modified-unstaged files — git()'s trim() would eat it on the first line and
// shift the `XY ` prefix parsing by one (hasChangesBeyond miscounted AGENTS.md
// as a foreign change because of exactly this).
function gitRaw(cwd, args) {
	return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

export function isGitRepo(cwd) {
	try {
		return git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
	} catch {
		return false;
	}
}

export function isCleanTree(cwd) {
	try {
		return git(cwd, ['status', '--porcelain']) === '';
	} catch {
		return true;
	}
}

/** True if the tree has changes beyond the paths krafto itself touches. */
export function hasChangesBeyond(cwd, allowed) {
	try {
		return gitRaw(cwd, ['status', '--porcelain'])
			.split('\n')
			.filter(Boolean)
			.some((line) => {
				const path = line.slice(3); // strip the `XY ` status prefix
				return !allowed.some((a) => path === a || path.startsWith(a));
			});
	} catch {
		return false;
	}
}

export function currentBranch(cwd) {
	try {
		return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || null;
	} catch {
		return null;
	}
}

export function gitRemote(cwd) {
	try {
		const url = git(cwd, ['remote', 'get-url', 'origin']);
		const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
		return m ? { owner: m[1], name: m[2] } : null;
	} catch {
		return null;
	}
}

/**
 * Keep krafto's runtime artifacts out of `git status` without touching the
 * user's .gitignore: .git/info/exclude is repo-local and invisible to them.
 */
export function excludeFromGitStatus(cwd, lines) {
	try {
		const gitDir = git(cwd, ['rev-parse', '--git-common-dir']);
		const excludePath = join(gitDir.startsWith('/') ? gitDir : join(cwd, gitDir), 'info', 'exclude');
		const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
		const present = new Set(current.split('\n').map((l) => l.trim()));
		const missing = lines.filter((l) => !present.has(l));
		if (missing.length === 0) return;
		appendFileSync(
			excludePath,
			`${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`
		);
	} catch {
		// Cosmetic only — worst case `git status` shows krafto's runtime files.
	}
}

export function commitOnboarding(cwd, agentsDoc = null) {
	try {
		git(cwd, ['add', '.krafto/config.json', '.gitignore', ...(agentsDoc ? [agentsDoc] : [])]);
		git(cwd, ['commit', '-m', 'krafto: onboarding (config)']);
		return true;
	} catch {
		return false; // nothing to commit / not a repo — non-fatal
	}
}

// --- browser ---------------------------------------------------------------

export function openBrowser(url) {
	const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
	try {
		spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
	} catch {
		// Caller always prints the URL too, so a failed auto-open is harmless.
	}
}

// --- .krafto files ---------------------------------------------------------

function kraftoDir(cwd) {
	const dir = join(cwd, '.krafto');
	mkdirSync(dir, { recursive: true });
	return dir;
}

export function writeConfig(cwd, config) {
	writeFileSync(join(kraftoDir(cwd), 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

export function writeSecrets(cwd, token) {
	writeFileSync(join(kraftoDir(cwd), 'secrets.env'), `KRAFTO_PROJECT_TOKEN=${token}\n`);
}

export function readConfig(cwd) {
	return JSON.parse(readFileSync(join(cwd, '.krafto', 'config.json'), 'utf8'));
}

export function readSecrets(cwd) {
	const out = {};
	for (const line of readFileSync(join(cwd, '.krafto', 'secrets.env'), 'utf8').split('\n')) {
		const eq = line.indexOf('=');
		if (eq > 0) out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	return out;
}

/**
 * The krafto section init offers to add to the project's agents doc
 * (AGENTS.md / CLAUDE.md) — how a coding agent runs the tool unattended.
 * No em dashes on purpose: this lands in the user's repo.
 */
const AGENTS_DOC_SECTION = `## krafto

This project is connected to krafto (https://krafto.ai), a visual editor for the running app.
Commands an AI agent can run unattended:

- \`npx krafto dev --detach\` starts the krafto agent in the background; logs go to \`.krafto/dev.log\`.
- \`npx krafto status --json\` reports the agent state: \`running\`, \`gateway\` ("online" once connected), \`devPort\`, live \`sessions\`.
- \`npx krafto stop\` stops the background agent and the dev servers it spawned.
- \`npx krafto init --name <name> --branch <branch> --yes --json\` re-connects non-interactively. Set \`KRAFTO_CONNECT_TOKEN\` to skip the browser confirmation.

Notes:
- \`.krafto/config.json\` is committed configuration. \`.krafto/secrets.env\` is gitignored and holds credentials, never read or commit it.
- Edits made in the krafto editor arrive as commits on \`krafto/<session-id>\` branches.
`;

export function appendAgentsDocSection(cwd, fileName) {
	const p = join(cwd, fileName);
	const current = existsSync(p) ? readFileSync(p, 'utf8') : '';
	const sep = current ? (current.endsWith('\n\n') ? '' : current.endsWith('\n') ? '\n' : '\n\n') : '';
	writeFileSync(p, `${current}${sep}${AGENTS_DOC_SECTION}`);
}

export function appendGitignore(cwd, line) {
	const p = join(cwd, '.gitignore');
	const current = existsSync(p) ? readFileSync(p, 'utf8') : '';
	if (current.split('\n').some((l) => l.trim() === line)) return;
	appendFileSync(p, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
}

// --- net -------------------------------------------------------------------

export async function isPortListening(port) {
	// Check both loopbacks: Vite binds `localhost`, which is ::1-only on modern
	// macOS/Node; Next.js binds 0.0.0.0 (IPv4). Either one counts as "up".
	const probe = (host) =>
		new Promise((resolve) => {
			const socket = net.createConnection({ port, host });
			socket.setTimeout(1000);
			socket.on('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.on('error', () => resolve(false));
			socket.on('timeout', () => {
				socket.destroy();
				resolve(false);
			});
		});
	const [v4, v6] = await Promise.all([probe('127.0.0.1'), probe('::1')]);
	return v4 || v6;
}
