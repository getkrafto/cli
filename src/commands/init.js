/**
 * `krafto init` — connect a project to krafto.
 *
 * detect → prompts → connect handshake (browser confirm, or a connect token
 * that skips the browser entirely) → write .krafto/config.json + secrets.env
 * → codemod (tag JSX with data-krafto-id, own commit) → optional krafto
 * section in AGENTS.md/CLAUDE.md → onboarding commit (skipped when the tree
 * has the user's own uncommitted changes — never sweep their work into ours).
 *
 * Agent-callable: `--name X --branch Y --yes` answers every prompt,
 * `--json` puts one machine-readable result object on stdout (progress moves
 * to stderr), `--connect-token` / KRAFTO_CONNECT_TOKEN authenticates without
 * a browser — together they make init safe to run from a coding agent or CI.
 *
 * The codemod is the only step that rewrites the user's sources, so it is the
 * only step with a clean check — scoped to tracked .tsx/.jsx, verified before
 * the browser step so a dirty tree fails before login.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitCodemod, dirtySourceFiles, runCodemod } from '../codemod.js';
import { detectProject, DetectError } from '../detect.js';
import { c, emitJson, error, info, isJsonMode, step } from '../ui.js';
import * as util from '../util.js';

const APP_URL = process.env.KRAFTO_APP_URL ?? 'https://app.krafto.ai';
const GATEWAY_URL = process.env.KRAFTO_GATEWAY_URL ?? 'wss://gateway.krafto.ai';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

export async function runInit(cwd, flags = {}) {
	// --yes (and --json, which must never hang on stdin) answers every prompt
	// with its default; explicit flags override the default itself.
	const assumeYes = Boolean(flags.yes || flags.json);
	const ask = (question, def) => (assumeYes ? Promise.resolve(def ?? '') : util.prompt(question, def));
	const askConfirm = (question, def) => (assumeYes ? Promise.resolve(def) : util.confirm(question, def));
	const fail = (msg) => {
		error(msg);
		if (isJsonMode()) emitJson({ ok: false, error: msg });
		process.exit(1);
	};

	let detected;
	try {
		detected = detectProject(cwd);
	} catch (err) {
		if (err instanceof DetectError) fail(err.message);
		throw err;
	}

	info('detected your project:');
	step(`framework        ${c.bold(detected.framework)}`);
	step(`package manager  ${detected.packageManager}`);
	step(`dev command      ${detected.devCommand}`);
	step(`dev port         ${detected.devPort}`);

	// The codemod rewrites .tsx/.jsx — refuse while they carry uncommitted
	// changes (checked before the browser step, so this fails before login).
	if (util.isGitRepo(cwd)) {
		const dirty = dirtySourceFiles(cwd);
		if (dirty.length > 0) {
			console.error('');
			error('these files have uncommitted changes, and init rewrites .tsx/.jsx (tagging):');
			for (const f of dirty.slice(0, 10)) step(f);
			fail('commit or stash them, then re-run `krafto init`');
		}
	}

	if (!isJsonMode()) console.log();
	const name = flags.name ?? (await ask('project name', detected.name));
	const branch = flags.branch ?? (await ask('branch', util.currentBranch(cwd) ?? 'main'));

	const remote = util.gitRemote(cwd);
	const githubRepo = remote ? { owner: remote.owner, name: remote.name, defaultBranch: branch } : null;
	const connectToken = flags.connectToken ?? process.env.KRAFTO_CONNECT_TOKEN;

	let token;
	if (connectToken) {
		// Headless path: the token authenticates the account, the project is
		// created in one round-trip — no browser, no polling (CI / coding agents).
		try {
			token = await postConnect({ projectName: name, githubRepo, branch, connectToken });
		} catch (err) {
			fail(
				err.status === 401
					? 'connect token is invalid or revoked — issue a new one in your dashboard'
					: `could not reach ${APP_URL}: ${err.message}`
			);
		}
		info(`connected with your token ${c.green('✓')}`);
	} else {
		let request;
		try {
			request = await postConnect({ projectName: name, githubRepo, branch });
		} catch (err) {
			fail(`could not reach ${APP_URL}: ${err.message}`);
		}

		const confirmUrl = `${APP_URL}/connect/${request.id}`;
		if (!isJsonMode()) console.log();
		// KRAFTO_NO_BROWSER: headless/SSH/CI — just print the URL to open elsewhere.
		if (process.env.KRAFTO_NO_BROWSER || isJsonMode()) {
			info(`confirm the connection in your browser: ${c.cyan(confirmUrl)}`);
		} else {
			info('opening your browser to confirm the connection…');
			util.openBrowser(confirmUrl);
			step(`if it didn't open, visit: ${c.cyan(confirmUrl)}`);
		}

		try {
			token = await pollConnect(request.id);
		} catch (err) {
			fail(err.message);
		}
	}

	util.writeConfig(cwd, {
		agentId: token.agentId,
		gateway: GATEWAY_URL,
		framework: detected.framework,
		devPort: detected.devPort,
		devCommand: detected.devCommand,
		packageManager: detected.packageManager,
		appDir: '.',
		commitEdits: false
	});
	util.writeSecrets(cwd, token.projectToken);
	util.appendGitignore(cwd, '.krafto/secrets.env');

	if (!isJsonMode()) console.log();
	info(`connected ${c.green('✓')} — ${c.bold(name)}`);
	step('wrote .krafto/config.json + .krafto/secrets.env (gitignored)');

	if (util.isGitRepo(cwd)) {
		if (!isJsonMode()) console.log();
		info('tagging elements for the editor (data-krafto-id)…');
		const result = await runCodemod(cwd);
		if (result.tagged === 0) {
			step('nothing to tag — elements already carry ids');
		} else if (commitCodemod(cwd, result.files)) {
			step(`tagged ${result.tagged} elements in ${result.files.length} files, committed on the current branch`);
		} else {
			step(`tagged ${result.tagged} elements in ${result.files.length} files (commit failed — commit them yourself)`);
		}
	} else {
		step('not a git repository — skipped element tagging (sessions need git anyway)');
	}

	if (detected.framework === 'next') {
		if (!isJsonMode()) console.log();
		info('Next.js: add this to your next.config so the dev server accepts the proxy:');
		step(c.bold("allowedDevOrigins: ['gateway.krafto.ai']"));
	}

	// Teach the user's coding agent the tool: a krafto section in the agents
	// doc means their AI can run dev/status/stop without being told how.
	let agentsDoc = null;
	const docTarget = agentsDocTarget(cwd);
	if (!docTarget.write) {
		step(`${docTarget.name} already has a krafto section`);
	} else if (
		await askConfirm(`add a krafto section to ${docTarget.name} (so your AI agents know the tool)?`, true)
	) {
		util.appendAgentsDocSection(cwd, docTarget.name);
		agentsDoc = docTarget.name;
		step(`added the krafto section to ${docTarget.name}`);
	}

	if (util.isGitRepo(cwd)) {
		// Auto-commit only when the tree has no changes of the user's own —
		// a plain `git commit` would sweep their staged work into our commit.
		const ours = ['.krafto', '.gitignore', ...(agentsDoc ? [agentsDoc] : [])];
		if (util.hasChangesBeyond(cwd, ours)) {
			step('your tree has uncommitted changes — skipped the auto-commit;');
			step(`commit ${c.bold('.krafto/config.json')} + ${c.bold('.gitignore')} together with your work`);
		} else if (util.commitOnboarding(cwd, agentsDoc)) {
			step('committed onboarding (config) on the current branch');
		}
	}

	if (!isJsonMode()) console.log();
	info(`done. run ${c.cyan('npx krafto dev')} to start the agent`);

	if (isJsonMode()) {
		emitJson({
			ok: true,
			projectId: token.projectId ?? null,
			agentId: token.agentId,
			name,
			branch,
			framework: detected.framework,
			devPort: detected.devPort,
			agentsDoc,
			next: 'npx krafto dev --detach'
		});
	}
}

/** AGENTS.md wins; fall back to an existing CLAUDE.md; else create AGENTS.md. */
function agentsDocTarget(cwd) {
	for (const name of ['AGENTS.md', 'CLAUDE.md']) {
		if (!existsSync(join(cwd, name))) continue;
		const hasSection = readFileSync(join(cwd, name), 'utf8').includes('## krafto');
		return { name, write: !hasSection };
	}
	return { name: 'AGENTS.md', write: true };
}

async function postConnect(payload) {
	const res = await fetch(`${APP_URL}/api/auth/connect`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});
	if (!res.ok) {
		const err = new Error(`connect request failed (HTTP ${res.status})`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

async function pollConnect(id) {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const res = await fetch(`${APP_URL}/api/auth/connect/${id}`);
		if (res.status === 404) {
			throw new Error('connect request expired before you confirmed — re-run `krafto init`');
		}
		if (res.ok) {
			const data = await res.json();
			if (data.status === 'ready') return data;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new Error('timed out waiting for confirmation — re-run `krafto init`');
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
