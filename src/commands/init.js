/**
 * `krafto init` — connect a project to krafto.
 *
 * detect → prompts → connect handshake (browser confirm) → write
 * .krafto/config.json + secrets.env → codemod (tag JSX with data-krafto-id,
 * own commit) → onboarding commit (skipped when the tree has the user's own
 * uncommitted changes — never sweep their work into ours).
 *
 * The codemod is the only step that rewrites the user's sources, so it is the
 * only step with a clean check — scoped to tracked .tsx/.jsx, verified before
 * the browser step so a dirty tree fails before login.
 */

import { commitCodemod, dirtySourceFiles, runCodemod } from '../codemod.js';
import { detectProject, DetectError } from '../detect.js';
import { c, error, info, step } from '../ui.js';
import * as util from '../util.js';

const APP_URL = process.env.KRAFTO_APP_URL ?? 'https://app.krafto.ai';
const GATEWAY_URL = process.env.KRAFTO_GATEWAY_URL ?? 'wss://gateway.krafto.ai';
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

export async function runInit(cwd) {
	let detected;
	try {
		detected = detectProject(cwd);
	} catch (err) {
		if (err instanceof DetectError) {
			error(err.message);
			process.exit(1);
		}
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
			console.log();
			error('these files have uncommitted changes, and init rewrites .tsx/.jsx (tagging):');
			for (const f of dirty.slice(0, 10)) step(f);
			error('commit or stash them, then re-run `krafto init`');
			process.exit(1);
		}
	}

	console.log();
	const name = await util.prompt('project name', detected.name);
	const branch = await util.prompt('branch', util.currentBranch(cwd) ?? 'main');

	const remote = util.gitRemote(cwd);
	const githubRepo = remote ? { owner: remote.owner, name: remote.name, defaultBranch: branch } : null;

	let request;
	try {
		request = await postConnect({ projectName: name, githubRepo, branch });
	} catch (err) {
		error(`could not reach ${APP_URL}: ${err.message}`);
		process.exit(1);
	}

	const confirmUrl = `${APP_URL}/connect/${request.id}`;
	console.log();
	// KRAFTO_NO_BROWSER: headless/SSH/CI — just print the URL to open elsewhere.
	if (process.env.KRAFTO_NO_BROWSER) {
		info(`confirm the connection in your browser: ${c.cyan(confirmUrl)}`);
	} else {
		info('opening your browser to confirm the connection…');
		util.openBrowser(confirmUrl);
		step(`if it didn't open, visit: ${c.cyan(confirmUrl)}`);
	}

	let token;
	try {
		token = await pollConnect(request.id);
	} catch (err) {
		error(err.message);
		process.exit(1);
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

	console.log();
	info(`connected ${c.green('✓')} — ${c.bold(name)}`);
	step('wrote .krafto/config.json + .krafto/secrets.env (gitignored)');

	if (util.isGitRepo(cwd)) {
		console.log();
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
		console.log();
		info('Next.js: add this to your next.config so the dev server accepts the proxy:');
		step(c.bold("allowedDevOrigins: ['gateway.krafto.ai']"));
	}

	if (util.isGitRepo(cwd)) {
		// Auto-commit only when the tree has no changes of the user's own —
		// a plain `git commit` would sweep their staged work into our commit.
		if (util.hasChangesBeyond(cwd, ['.krafto', '.gitignore'])) {
			step('your tree has uncommitted changes — skipped the auto-commit;');
			step(`commit ${c.bold('.krafto/config.json')} + ${c.bold('.gitignore')} together with your work`);
		} else if (util.commitOnboarding(cwd)) {
			step('committed onboarding (config) on the current branch');
		}
	}

	console.log();
	info(`done. run ${c.cyan('npx krafto dev')} to start the agent`);
}

async function postConnect(payload) {
	const res = await fetch(`${APP_URL}/api/auth/connect`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});
	if (!res.ok) throw new Error(`connect request failed (HTTP ${res.status})`);
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
