/**
 * `krafto ai` — run the user's own coding agent headless in this project.
 * Without a prompt it reports which agent CLIs are installed and which one
 * krafto would use. This is the CLI surface of the adapter in src/ai.js;
 * the editor (ai_prompt) and init reuse the same layer programmatically.
 */

import { buildAgentEnv, buildSystemContext, detectAgentClis, resolveAdapter, runAgent } from '../ai.js';
import { c, emitJson, error, info, isJsonMode, step } from '../ui.js';
import { readConfig, readSecrets } from '../util.js';

export async function runAi(cwd, flags) {
	const config = tryRead(() => readConfig(cwd));
	const secrets = tryRead(() => readSecrets(cwd));

	let prompt = flags.prompt;
	if (!prompt && !process.stdin.isTTY) prompt = (await readStdin()).trim();

	if (!prompt) {
		printDetection(config, flags);
		return;
	}

	const { adapter, error: resolveError } = resolveAdapter(config, flags.agent ?? null);
	if (!adapter) {
		const msg = resolveError ?? noAgentMessage();
		if (isJsonMode()) emitJson({ ok: false, error: msg });
		else error(msg);
		process.exit(1);
	}

	let env;
	try {
		env = buildAgentEnv(adapter, config, secrets);
	} catch (err) {
		if (isJsonMode()) emitJson({ ok: false, error: err.message });
		else error(err.message);
		process.exit(1);
	}

	info(`asking ${adapter.name}${config?.ai?.auth === 'api-key' ? ' (api key)' : ''}…`);
	// In --json mode stdout carries exactly one JSON object, so the live
	// stream moves to stderr; statuses go to stderr in both modes to keep
	// the answer text clean.
	const writeDelta = (t) => (isJsonMode() ? process.stderr : process.stdout).write(t);
	let streamed = false;
	const result = await runAgent({
		adapter,
		cwd,
		prompt,
		systemContext: buildSystemContext(config),
		env,
		allowEdits: !flags.readOnly,
		onDelta: (t) => {
			streamed = true;
			writeDelta(t);
		},
		onStatus: (line) => process.stderr.write(`  ${c.gray(`› ${line}`)}\n`)
	});
	if (streamed) writeDelta('\n');

	if (isJsonMode()) {
		emitJson({
			ok: result.ok,
			agent: adapter.id,
			output: result.text ?? '',
			error: result.error,
			durationMs: result.durationMs,
			costUsd: result.costUsd,
			turns: result.turns
		});
	} else if (result.ok) {
		const cost = result.costUsd != null ? ` · $${result.costUsd.toFixed(2)}` : '';
		console.error(c.gray(`  done in ${(result.durationMs / 1000).toFixed(1)}s${cost}`));
	} else {
		error(result.error ?? 'agent failed');
	}
	process.exit(result.ok ? 0 : 1);
}

function printDetection(config, flags) {
	const detected = detectAgentClis();
	const { adapter } = resolveAdapter(config, flags.agent ?? null);
	if (isJsonMode()) {
		emitJson({
			ok: true,
			agents: detected.map((a) => ({
				id: a.id,
				name: a.name,
				available: a.available,
				implemented: a.implemented,
				path: a.path
			})),
			selected: adapter?.id ?? null,
			auth: config?.ai?.auth ?? 'subscription'
		});
		return;
	}
	info('agent CLIs on this machine:');
	for (const a of detected) {
		if (a.available) {
			const note = a.implemented ? (a.id === adapter?.id ? c.cyan('← will be used') : '') : c.gray('(support coming)');
			step(`${c.green('✓')} ${a.name} ${c.gray(a.path)} ${note}`);
		} else {
			step(`${c.gray('✗')} ${a.name} ${c.gray(`not found — ${a.installHint}`)}`);
		}
	}
	if (adapter) {
		step(`auth: ${config?.ai?.auth ?? 'subscription'} ${c.gray('(set "ai" in .krafto/config.json to change)')}`);
		step(`try: ${c.cyan('npx krafto ai "describe this project"')}`);
	} else {
		step(noAgentMessage());
	}
}

function noAgentMessage() {
	return 'no agent CLI found — install Claude Code (npm install -g @anthropic-ai/claude-code) or Codex to unlock AI features';
}

function tryRead(fn) {
	try {
		return fn();
	} catch {
		return null; // not initialized here — the command still works
	}
}

function readStdin() {
	return new Promise((resolve) => {
		let data = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', (d) => (data += d));
		process.stdin.on('end', () => resolve(data));
	});
}
