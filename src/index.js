#!/usr/bin/env node
/**
 * krafto CLI entry + argument router. Plain Node ≥18, no arg framework —
 * process.argv + src/args.js is enough.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFlags } from './args.js';
import { runAi } from './commands/ai.js';
import { runDev } from './commands/dev.js';
import { runInit } from './commands/init.js';
import { runStatus } from './commands/status.js';
import { runStop } from './commands/stop.js';
import { c, setJsonMode } from './ui.js';

const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);

switch (cmd) {
	case 'init': {
		const flags = parseFlags(rest, {
			name: 'string',
			branch: 'string',
			'connect-token': 'string',
			yes: 'boolean',
			json: 'boolean'
		});
		if (flags.json) setJsonMode(true);
		await runInit(process.cwd(), flags);
		break;
	}
	case 'dev': {
		const flags = parseFlags(rest, { detach: 'boolean' });
		await runDev(process.cwd(), flags);
		break;
	}
	case 'ai': {
		// The prompt is the one positional argument: krafto ai "make it blue".
		const positional = rest[0] && !rest[0].startsWith('--') ? rest[0] : null;
		const flags = parseFlags(positional ? rest.slice(1) : rest, {
			agent: 'string',
			'read-only': 'boolean',
			json: 'boolean'
		});
		if (flags.json) setJsonMode(true);
		await runAi(process.cwd(), { ...flags, prompt: positional });
		break;
	}
	case 'status': {
		const flags = parseFlags(rest, { json: 'boolean' });
		if (flags.json) setJsonMode(true);
		await runStatus(process.cwd(), flags);
		break;
	}
	case 'stop': {
		const flags = parseFlags(rest, { json: 'boolean' });
		if (flags.json) setJsonMode(true);
		await runStop(process.cwd(), flags);
		break;
	}
	case '--version':
	case '-v':
		console.log(version());
		break;
	default:
		printBanner();
}

function version() {
	const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
	return JSON.parse(readFileSync(pkg, 'utf8')).version;
}

function printBanner() {
	const banner = `
${c.cyan(c.bold('  ██╗  ██╗██████╗  █████╗ ███████╗████████╗ ██████╗ '))}
${c.cyan(c.bold('  ██║ ██╔╝██╔══██╗██╔══██╗██╔════╝╚══██╔══╝██╔═══██╗'))}
${c.cyan(c.bold('  █████╔╝ ██████╔╝███████║█████╗     ██║   ██║   ██║'))}
${c.cyan(c.bold('  ██╔═██╗ ██╔══██╗██╔══██║██╔══╝     ██║   ██║   ██║'))}
${c.cyan(c.bold('  ██║  ██╗██║  ██║██║  ██║██║        ██║   ╚██████╔╝'))}
${c.cyan(c.bold('  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝        ╚═╝    ╚═════╝ '))}
`;
	process.stdout.write(banner);
	process.stdout.write(`${c.magenta(c.bold('  Visual editor for your existing React codebase'))}\n\n`);
	process.stdout.write(`  ${c.bold('Usage:')}\n`);
	process.stdout.write(`    ${c.cyan('npx krafto init')}     ${c.gray('connect this project to krafto')}\n`);
	process.stdout.write(`    ${c.cyan('npx krafto dev')}      ${c.gray('run the agent + your dev server (--detach for background)')}\n`);
	process.stdout.write(`    ${c.cyan('npx krafto ai')}       ${c.gray('ask your own coding agent (Claude Code) to change this project')}\n`);
	process.stdout.write(`    ${c.cyan('npx krafto status')}   ${c.gray('is the agent running? (--json for machines)')}\n`);
	process.stdout.write(`    ${c.cyan('npx krafto stop')}     ${c.gray('stop the background agent')}\n\n`);
}
