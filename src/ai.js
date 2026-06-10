/**
 * AI adapter layer — the user's own coding agent, never our keys (MVP central
 * stream). krafto spawns the agent CLI already installed on the machine
 * (Claude Code / Codex) in headless mode and streams its output. The adapter
 * interface covers both CLIs; only Claude Code is implemented for now — Codex
 * detection works, invocation says "coming".
 *
 * Auth modes (both via the agent CLI, krafto makes no direct API requests):
 *   - subscription (default): the agent CLI is already logged in, spawn as-is
 *   - api-key: the key lives in gitignored .krafto/secrets.env and is passed
 *     to the agent via its env var at spawn time
 * Mode and preferred agent live in .krafto/config.json under "ai"
 * ({ agent: 'claude'|'codex', auth: 'subscription'|'api-key' }) — optional,
 * defaults apply when absent.
 */

import { execFileSync, spawn } from 'node:child_process';

export const ADAPTERS = [
	{
		id: 'claude',
		name: 'Claude Code',
		bin: 'claude',
		apiKeyEnv: 'ANTHROPIC_API_KEY',
		// Subscription-in-container path (claude setup-token); passed through
		// from secrets.env when present, harmless on a dev machine.
		envPassthrough: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
		installHint: 'npm install -g @anthropic-ai/claude-code',
		implemented: true,
		buildArgs({ systemContext, allowEdits }) {
			// --verbose is required for stream-json with -p; partial messages
			// give token-level deltas (the editor's ai_delta needs them too).
			const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
			if (systemContext) args.push('--append-system-prompt', systemContext);
			// acceptEdits auto-approves file edits only — Bash etc. stay gated.
			if (allowEdits) args.push('--permission-mode', 'acceptEdits');
			return args;
		},
		parseEvent(ev) {
			if (ev.type === 'stream_event') {
				const e = ev.event;
				if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
					return { delta: e.delta.text };
				}
				return null;
			}
			if (ev.type === 'assistant') {
				// Tool calls surface as status lines ("Edit src/app/page.tsx").
				const tool = (ev.message?.content ?? []).find((b) => b.type === 'tool_use');
				if (tool) {
					const target = tool.input?.file_path ?? tool.input?.pattern ?? tool.input?.command ?? '';
					return { status: `${tool.name} ${String(target).slice(0, 80)}`.trim() };
				}
				return null;
			}
			if (ev.type === 'result') {
				return {
					result: {
						ok: !ev.is_error,
						text: ev.result ?? '',
						durationMs: ev.duration_ms,
						costUsd: ev.total_cost_usd,
						turns: ev.num_turns,
						agentSessionId: ev.session_id
					}
				};
			}
			return null;
		}
	},
	{
		id: 'codex',
		name: 'Codex CLI',
		bin: 'codex',
		apiKeyEnv: 'OPENAI_API_KEY',
		envPassthrough: ['OPENAI_API_KEY'],
		installHint: 'npm install -g @openai/codex',
		// Interface is reserved (codex exec --json); implementation lands
		// after Claude Code per the MVP order.
		implemented: false
	}
];

function which(bin) {
	try {
		return (
			execFileSync('which', [bin], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() ||
			null
		);
	} catch {
		return null;
	}
}

/** All known agent CLIs with availability on this machine. */
export function detectAgentClis() {
	return ADAPTERS.map((a) => ({ ...a, path: which(a.bin), available: which(a.bin) !== null }));
}

/**
 * Pick the agent CLI to run: explicit override > config.ai.agent preference >
 * registry order. Returns { adapter, detected, error } — adapter is null when
 * nothing usable is installed (callers degrade softly, AI is never required).
 */
export function resolveAdapter(config, overrideId = null) {
	const detected = detectAgentClis();
	const byId = (id) => detected.find((a) => a.id === id);

	if (overrideId) {
		const a = byId(overrideId);
		if (!a) return { detected, adapter: null, error: `unknown agent "${overrideId}" (known: ${ADAPTERS.map((x) => x.id).join(', ')})` };
		if (!a.available) return { detected, adapter: null, error: `${a.name} is not installed (${a.installHint})` };
		if (!a.implemented) return { detected, adapter: null, error: `${a.name} support is coming — only Claude Code is implemented right now` };
		return { detected, adapter: a };
	}

	const preferred = config?.ai?.agent ? byId(config.ai.agent) : null;
	const order = preferred ? [preferred, ...detected.filter((a) => a !== preferred)] : detected;
	const adapter = order.find((a) => a.available && a.implemented) ?? null;
	return { detected, adapter };
}

/**
 * Env for the agent spawn. Subscription mode inherits the dev's env untouched;
 * api-key mode requires the key in .krafto/secrets.env and overlays it.
 * Known agent creds found in secrets.env are passed through in both modes
 * (that's where the container story puts CLAUDE_CODE_OAUTH_TOKEN).
 */
export function buildAgentEnv(adapter, config, secrets) {
	const env = { ...process.env };
	for (const key of adapter.envPassthrough ?? []) {
		if (secrets?.[key]) env[key] = secrets[key];
	}
	const mode = config?.ai?.auth ?? 'subscription';
	if (mode === 'api-key' && !env[adapter.apiKeyEnv]) {
		throw new Error(
			`ai.auth is "api-key" but ${adapter.apiKeyEnv} is not set — add it to .krafto/secrets.env`
		);
	}
	return env;
}

/** Baseline system context every krafto-spawned agent gets; callers append their own. */
export function buildSystemContext(config, extra = '') {
	const lines = [
		'You are invoked by krafto, a visual editor for this React codebase.'
	];
	if (config?.framework) {
		lines.push(
			`Project: framework ${config.framework}, dev command "${config.devCommand}", dev port ${config.devPort}, package manager ${config.packageManager}.`
		);
	}
	lines.push(
		'JSX elements may carry data-krafto-id attributes; krafto needs them — never remove, rename, or duplicate them.',
		'.krafto/secrets.env holds credentials; never read, print, or commit it.'
	);
	if (extra) lines.push(extra);
	return lines.join('\n');
}

/**
 * Run one headless agent turn. Streams via onDelta(text) / onStatus(line),
 * resolves { ok, text, durationMs, costUsd, turns, agentSessionId, error } —
 * never rejects (AI failures must not take the caller down).
 */
export function runAgent({ adapter, cwd, prompt, systemContext, env, allowEdits = false, onDelta, onStatus, timeoutMs = 0 }) {
	return new Promise((resolve) => {
		const args = adapter.buildArgs({ systemContext, allowEdits });
		let child;
		try {
			child = spawn(adapter.path ?? adapter.bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
		} catch (err) {
			resolve({ ok: false, error: `failed to spawn ${adapter.bin}: ${err.message}` });
			return;
		}
		child.stdin.write(prompt);
		child.stdin.end();

		let buf = '';
		let result = null;
		let stderr = '';
		let timer = null;
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				stderr += `\nkrafto: agent timed out after ${timeoutMs}ms`;
				child.kill('SIGTERM');
			}, timeoutMs);
		}

		child.stdout.on('data', (chunk) => {
			buf += chunk;
			let nl;
			while ((nl = buf.indexOf('\n')) !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) continue;
				let ev;
				try {
					ev = JSON.parse(line);
				} catch {
					continue; // not an event line — ignore
				}
				const out = adapter.parseEvent(ev);
				if (!out) continue;
				if (out.delta) onDelta?.(out.delta);
				if (out.status) onStatus?.(out.status);
				if (out.result) result = out.result;
			}
		});
		child.stderr.on('data', (d) => {
			stderr += d;
		});
		child.on('error', (err) => {
			if (timer) clearTimeout(timer);
			resolve({ ok: false, error: `failed to spawn ${adapter.bin}: ${err.message}` });
		});
		child.on('close', (code) => {
			if (timer) clearTimeout(timer);
			if (result) {
				resolve(result.ok ? result : { ...result, error: result.text || 'agent reported an error' });
			} else {
				resolve({
					ok: false,
					error: `${adapter.bin} exited with code ${code}${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}`
				});
			}
		});
	});
}
