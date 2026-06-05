/**
 * `krafto init` — connect a project to krafto.
 *
 * detect → clean-tree check → prompts → connect handshake (browser confirm) →
 * write .krafto/config.json + secrets.env → onboarding commit.
 *
 * Codemod (data-krafto-id) is the editing layer and lands later; this is enough
 * to view the project in the editor.
 */

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

	// Codemod (later) rewrites source — keep the tree clean so the diff is obvious.
	if (util.isGitRepo(cwd) && !util.isCleanTree(cwd)) {
		error('working tree has uncommitted changes — commit or stash first, then re-run');
		process.exit(1);
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
	step('wrote .krafto/config.json (committed) + .krafto/secrets.env (gitignored)');

	if (detected.framework === 'next') {
		console.log();
		info('Next.js: add this to your next.config so the dev server accepts the proxy:');
		step(c.bold("allowedDevOrigins: ['gateway.krafto.ai']"));
	}

	if (util.isGitRepo(cwd)) {
		if (util.commitOnboarding(cwd)) step('committed onboarding (config) on the current branch');
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
