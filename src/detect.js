/**
 * Deterministic project detection for `krafto init`. No AI, no netstat —
 * everything comes from package.json, lockfiles, dev script and config files.
 *
 * Returns { framework, packageManager, devCommand, devPort, appDir, name }
 * or throws DetectError with a message safe to show the user.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export class DetectError extends Error {}

const FRAMEWORK_DEFAULT_PORT = { next: 3000, 'vite-react': 5173 };

export function detectProject(cwd) {
	const pkgPath = join(cwd, 'package.json');
	if (!existsSync(pkgPath)) {
		throw new DetectError('no package.json here — run `krafto init` in your project root');
	}
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
	} catch (err) {
		throw new DetectError(`package.json is not valid JSON: ${err.message}`);
	}

	// Monorepo → hard stop (appDir/devCommand are kept in config for later support).
	const hasWorkspaces =
		Array.isArray(pkg.workspaces) || (pkg.workspaces != null && typeof pkg.workspaces === 'object');
	if (hasWorkspaces || existsSync(join(cwd, 'pnpm-workspace.yaml'))) {
		throw new DetectError('monorepo support is coming after the PoC');
	}

	const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
	let framework;
	if (deps.next) {
		framework = 'next';
	} else if (deps.vite && (deps['@vitejs/plugin-react'] || deps['@vitejs/plugin-react-swc'])) {
		framework = 'vite-react';
	} else {
		throw new DetectError('unsupported framework — krafto supports Next.js and Vite + React');
	}

	const devCommand = pkg.scripts?.dev;
	if (!devCommand || typeof devCommand !== 'string') {
		throw new DetectError('no "dev" script in package.json — krafto needs one to run your dev server');
	}

	return {
		framework,
		packageManager: detectPackageManager(cwd),
		devCommand,
		devPort: detectPort(cwd, framework, devCommand),
		appDir: '.',
		name: typeof pkg.name === 'string' && pkg.name ? pkg.name : basename(cwd)
	};
}

function detectPackageManager(cwd) {
	if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return 'bun';
	if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
	if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
	if (existsSync(join(cwd, 'package-lock.json'))) return 'npm';
	return 'npm'; // no lockfile yet — npm is the safe default
}

function detectPort(cwd, framework, devCommand) {
	// 1. Explicit flag in the dev script: -p 4000 | --port 4000 | --port=4000
	const flag = devCommand.match(/(?:-p|--port)[=\s]+(\d{2,5})/);
	if (flag) return Number(flag[1]);

	// 2. Vite: server.port in vite.config.* (best-effort — no config execution)
	if (framework === 'vite-react') {
		for (const file of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts']) {
			const p = join(cwd, file);
			if (!existsSync(p)) continue;
			const port = readFileSync(p, 'utf8').match(/server\s*:\s*\{[^}]*?\bport\s*:\s*(\d{2,5})/s);
			if (port) return Number(port[1]);
			break;
		}
	}

	// 3. Framework default
	return FRAMEWORK_DEFAULT_PORT[framework];
}
