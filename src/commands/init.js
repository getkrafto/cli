/**
 * `krafto init` — connect a project to krafto.
 *
 * This build covers deterministic detection. Still to land (next):
 * clean-tree check, name/branch prompts, connect handshake + poll, codemod,
 * .krafto/config.json + secrets.env, onboarding commit.
 */

import { detectProject, DetectError } from '../detect.js';
import { c, error, info, step } from '../ui.js';

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
	console.log();
	info(c.gray('connect handshake, codemod and config writing land in the next build'));
}
