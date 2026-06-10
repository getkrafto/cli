/**
 * Onboarding codemod: add data-krafto-id="<id>" to JSX elements so the editor
 * has something to select and the edit applier something to find. ts-morph
 * (AST), never regex.
 *
 * Only intrinsic elements (lowercase tags) are tagged — they reach the DOM,
 * where the preload's closest('[data-krafto-id]') finds them. Components keep
 * their internals tagged instead. Already-tagged elements are left alone, so
 * re-running init is idempotent.
 *
 * This is the ONLY step with a clean-tree requirement, scoped to the files it
 * rewrites: tracked .tsx/.jsx must have no uncommitted changes (decision
 * 2026-06-05). The tag commit is separate from the config commit — sessions
 * fork from it and inherit the ids.
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { customAlphabet } from 'nanoid';

const newId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

function git(cwd, args) {
	return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

/** Tracked .tsx/.jsx files with uncommitted changes — they block the codemod. */
export function dirtySourceFiles(cwd) {
	try {
		return git(cwd, ['status', '--porcelain', '--', '*.tsx', '*.jsx'])
			.split('\n')
			.filter(Boolean)
			.map((line) => line.slice(3));
	} catch {
		return [];
	}
}

export async function runCodemod(cwd) {
	const files = git(cwd, ['ls-files', '--', '*.tsx', '*.jsx']).split('\n').filter(Boolean);
	if (files.length === 0) return { tagged: 0, files: [] };

	const { Project, SyntaxKind } = await import('ts-morph');
	const project = new Project({
		skipAddingFilesFromTsConfig: true,
		skipFileDependencyResolution: true
	});

	const touched = [];
	let tagged = 0;
	for (const file of files) {
		const sf = project.addSourceFileAtPath(join(cwd, file));
		let changed = false;
		// Re-query after every insertion: a manipulation can invalidate other
		// node wrappers, so holding a collected list across edits isn't safe.
		for (;;) {
			const el = firstUntaggedElement(sf, SyntaxKind);
			if (!el) break;
			el.addAttribute({ name: 'data-krafto-id', initializer: `"${newId()}"` });
			changed = true;
			tagged++;
		}
		if (changed) {
			sf.saveSync();
			touched.push(file);
		}
	}
	return { tagged, files: touched };
}

function firstUntaggedElement(sf, SyntaxKind) {
	for (const kind of [SyntaxKind.JsxOpeningElement, SyntaxKind.JsxSelfClosingElement]) {
		for (const el of sf.getDescendantsOfKind(kind)) {
			const tag = el.getTagNameNode().getText();
			if (!/^[a-z]/.test(tag)) continue; // intrinsic DOM elements only
			if (el.getAttribute('data-krafto-id')) continue;
			return el;
		}
	}
	return null;
}

/** Commit exactly the rewritten files (they were clean — these are our changes only). */
export function commitCodemod(cwd, files) {
	try {
		git(cwd, ['add', '--', ...files]);
		git(cwd, ['commit', '-m', 'krafto: tag elements (data-krafto-id)', '--', ...files]);
		return true;
	} catch {
		return false;
	}
}
