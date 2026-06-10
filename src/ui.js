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

// --json mode: stdout carries exactly one JSON object (emitJson), so the
// human-readable progress moves to stderr — visible in logs, never parsed.
let jsonMode = false;

export function setJsonMode(on) {
	jsonMode = on;
}

export function isJsonMode() {
	return jsonMode;
}

export function info(msg) {
	const line = `${c.cyan('krafto')} ${msg}`;
	if (jsonMode) console.error(line);
	else console.log(line);
}

export function step(msg) {
	const line = `  ${c.gray('›')} ${msg}`;
	if (jsonMode) console.error(line);
	else console.log(line);
}

export function error(msg) {
	console.error(`${c.red('krafto')} ${msg}`);
}

/** The single machine-readable result of a --json invocation. */
export function emitJson(obj) {
	console.log(JSON.stringify(obj));
}
