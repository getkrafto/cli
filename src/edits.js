/**
 * Edit applier: turns an `edit` command into a source change in a session
 * worktree, via ts-morph (AST, not regex), then auto-commits to the session
 * branch. HMR picks the change up from the file write — git is bookkeeping.
 *
 * Lookup is id-keyed: grep the worktree for data-krafto-id="<elementId>",
 * then patch the matching JSX element. Supported changes mirror the protocol:
 * className (plain string only) and text (plain text content only).
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

let tsMorph = null;
async function loadTsMorph() {
	// Lazy: ts-morph is heavy and `krafto dev` shouldn't pay for it until the
	// first edit arrives.
	if (!tsMorph) tsMorph = await import('ts-morph');
	return tsMorph;
}

export async function applyEdit(dir, msg) {
	const { elementId, change } = msg;
	const file = findFileWithId(dir, elementId);
	if (!file) return { ok: false, error: `no source file contains data-krafto-id="${elementId}"` };

	const { Project } = await loadTsMorph();
	const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
	const sf = project.addSourceFileAtPath(join(dir, file));

	const el = findJsxElementById(sf, elementId);
	if (!el) return { ok: false, error: `element ${elementId} not found in ${file}` };

	let error = null;
	if (change.kind === 'className') error = setClassName(el, change.value);
	else if (change.kind === 'text') error = setText(el, change.value);
	else error = `unsupported change kind`;
	if (error) return { ok: false, error };

	sf.saveSync(); // the write is what triggers HMR
	const commitSha = commitEdit(dir, file, elementId, change.kind, msg.author);
	return { ok: true, file, commitSha };
}

/** Tracked .tsx/.jsx files only — git grep is fast and skips node_modules. */
function findFileWithId(dir, elementId) {
	try {
		const out = execFileSync(
			'git',
			['grep', '-l', '--fixed-strings', `data-krafto-id="${elementId}"`, '--', '*.tsx', '*.jsx'],
			{ cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }
		)
			.toString()
			.trim();
		return out.split('\n').filter(Boolean)[0] ?? null;
	} catch {
		return null; // git grep exits 1 on no match
	}
}

function findJsxElementById(sf, elementId) {
	for (const attr of sf.getDescendantsOfKind(tsMorph.SyntaxKind.JsxAttribute)) {
		if (attr.getNameNode().getText() !== 'data-krafto-id') continue;
		const init = attr.getInitializer();
		if (!init || !init.isKind(tsMorph.SyntaxKind.StringLiteral)) continue;
		if (init.getLiteralValue() !== elementId) continue;
		// JsxAttribute → JsxAttributes → JsxOpeningElement | JsxSelfClosingElement
		return attr.getParent().getParent();
	}
	return null;
}

function setClassName(el, value) {
	const attr = el.getAttribute('className');
	const initializer = `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
	if (!attr) {
		el.addAttribute({ name: 'className', initializer });
		return null;
	}
	const init = attr.getInitializer();
	if (init && !init.isKind(tsMorph.SyntaxKind.StringLiteral)) {
		// clsx()/template/conditional className — out of PoC scope, fail loud.
		return 'className is not a plain string in the source — edit it in code';
	}
	attr.setInitializer(initializer);
	return null;
}

function setText(el, value) {
	if (el.isKind(tsMorph.SyntaxKind.JsxSelfClosingElement)) {
		return 'a self-closing element has no text';
	}
	const jsxEl = el.getParentIfKind(tsMorph.SyntaxKind.JsxElement);
	if (!jsxEl) return 'cannot resolve the element body';
	const meaningful = jsxEl
		.getJsxChildren()
		.filter((c) => !(c.isKind(tsMorph.SyntaxKind.JsxText) && c.containsOnlyTriviaWhiteSpaces()));
	const plainText =
		meaningful.length === 0 ||
		(meaningful.length === 1 && meaningful[0].isKind(tsMorph.SyntaxKind.JsxText));
	if (!plainText) {
		return 'element has nested content — edit the inner elements instead';
	}
	// Plain text when JSX-safe; expression form for anything with {}<>& etc.
	jsxEl.setBodyTextInline(/^[^{}<>]*$/.test(value) ? value : `{${JSON.stringify(value)}}`);
	return null;
}

/**
 * Auto-commit to the session branch (this is krafto's own branch — the dev's
 * tree and branches are never touched). Only the edited file, never -a.
 * Falls back to a krafto identity when the user has none configured.
 */
function commitEdit(dir, file, elementId, kind, author) {
	const git = (args) =>
		execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
	try {
		git(['add', '--', file]);
		let message = `krafto: ${kind} edit on ${elementId}`;
		// Sessions are shared: the edit may come from any member's browser while
		// the committer is whoever runs the agent. Credit the actual editor
		// (gateway-stamped identity) so the forge shows both — unless they are
		// the same person.
		if (author?.email) {
			let committerEmail = null;
			try {
				committerEmail = git(['config', 'user.email']);
			} catch {
				/* none configured — the krafto identity fallback below kicks in */
			}
			if (committerEmail !== author.email) {
				message += `\n\nCo-authored-by: ${author.name || author.email} <${author.email}>`;
			}
		}
		try {
			git(['commit', '-m', message, '--', file]);
		} catch {
			git([
				'-c',
				'user.name=krafto agent',
				'-c',
				'user.email=agent@krafto.ai',
				'commit',
				'-m',
				message,
				'--',
				file
			]);
		}
		return git(['rev-parse', 'HEAD']);
	} catch (err) {
		// The file write already landed (HMR fired) — a failed commit must not
		// fail the edit. Surface it in the daemon output only.
		console.error(`[krafto] session commit failed: ${err.message}`);
		return null;
	}
}
