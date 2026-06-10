/**
 * Tiny argv flag parser — `--flag value`, `--flag=value` and boolean flags.
 * No framework (style rule); unknown flags fail loud so an AI agent's typo
 * surfaces immediately instead of being silently ignored.
 */

import { error } from './ui.js';

/**
 * spec: { name: 'string', yes: 'boolean', ... } keyed by long flag name.
 * Returns { [camelCased flag]: value }. Exits 1 on unknown flag / missing value.
 */
export function parseFlags(argv, spec) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) {
			error(`unexpected argument: ${arg}`);
			process.exit(1);
		}
		const eq = arg.indexOf('=');
		const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
		const kind = spec[name];
		if (!kind) {
			error(`unknown flag: --${name}`);
			process.exit(1);
		}
		if (kind === 'boolean') {
			if (eq !== -1) {
				error(`--${name} takes no value`);
				process.exit(1);
			}
			out[camel(name)] = true;
			continue;
		}
		const value = eq !== -1 ? arg.slice(eq + 1) : argv[++i];
		if (value === undefined || (eq === -1 && value.startsWith('--'))) {
			error(`--${name} requires a value`);
			process.exit(1);
		}
		out[camel(name)] = value;
	}
	return out;
}

function camel(name) {
	return name.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}
