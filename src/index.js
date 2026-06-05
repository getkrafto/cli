#!/usr/bin/env node
/**
 * krafto CLI entry + argument router. Plain Node ≥18, no arg framework —
 * process.argv is enough for `init` / `dev`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInit } from './commands/init.js';
import { c } from './ui.js';

const args = process.argv.slice(2);
const cmd = args[0];

switch (cmd) {
	case 'init':
		await runInit(process.cwd());
		break;
	case 'dev':
		console.log(`${c.cyan('krafto')} dev — agent daemon lands in the next build`);
		break;
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
	process.stdout.write(`    ${c.cyan('npx krafto init')}   ${c.gray('connect this project to krafto')}\n`);
	process.stdout.write(`    ${c.cyan('npx krafto dev')}    ${c.gray('run the agent + your dev server')}\n\n`);
}
