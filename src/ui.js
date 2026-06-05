/** Tiny terminal output helpers — no dependencies. */

const tty = process.stdout.isTTY;
const wrap = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
	bold: wrap(1),
	dim: wrap(2),
	cyan: wrap(36),
	magenta: wrap(35),
	gray: wrap(90),
	red: wrap(31),
	green: wrap(32)
};

export function info(msg) {
	console.log(`${c.cyan('krafto')} ${msg}`);
}

export function step(msg) {
	console.log(`  ${c.gray('›')} ${msg}`);
}

export function error(msg) {
	console.error(`${c.red('krafto')} ${msg}`);
}
