/**
 * Pages panel: discover the project's routes (`routes_request` → `routes`).
 *
 * Next — deterministic filesystem scan: App Router (app/ or src/app, every
 * dir with a page.*), plus Pages Router (pages/ or src/pages) when present.
 * Vite — routes live in code, not the filesystem: best-effort react-router
 * parse via ts-morph (<Route path> JSX trees and createBrowserRouter object
 * literals). When nothing parses, the reply says source:'none' honestly and
 * the editor falls back to "navigate inside the page".
 *
 * Scans the session's worktree when one exists (a session may have added or
 * removed pages), the main checkout otherwise (fresh session = fork of HEAD).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { error, step } from './ui.js';

const PAGE_EXTS = ['tsx', 'jsx', 'ts', 'js'];

let tsMorph = null;
async function loadTsMorph() {
	// Lazy, same as edits.js: don't pay for ts-morph until the first request.
	if (!tsMorph) tsMorph = await import('ts-morph');
	return tsMorph;
}

export async function handleRoutesRequest(cwd, config, sessions, send, msg) {
	const reply = (payload) =>
		send({ type: 'routes', requestId: msg.requestId, sessionId: msg.sessionId, ...payload });
	try {
		const dir =
			(msg.sessionId &&
				(sessions.dirFor(msg.sessionId) ?? sessions.dormantDirFor(msg.sessionId))) ||
			cwd;
		const { routes, source } =
			config.framework === 'next' ? scanNextRoutes(dir) : await scanReactRouterRoutes(dir);
		routes.sort((a, b) => a.path.localeCompare(b.path));
		step(`routes: ${routes.length} found (${source})`);
		reply({ ok: true, routes, source });
	} catch (err) {
		error(`routes for session ${msg.sessionId} failed: ${err.message}`);
		reply({ ok: false, error: String(err.message).slice(0, 500) });
	}
}

// ---------------------------------------------------------------------------
// Next.js — filesystem scan
// ---------------------------------------------------------------------------

function scanNextRoutes(dir) {
	const routes = [];
	const appRoot = firstExisting(dir, ['app', 'src/app']);
	if (appRoot) walkAppRouter(dir, appRoot, '', routes);
	const pagesRoot = firstExisting(dir, ['pages', 'src/pages']);
	if (pagesRoot) walkPagesRouter(dir, pagesRoot, '', routes);
	return { routes: dedupe(routes), source: 'next' };
}

function firstExisting(dir, candidates) {
	return candidates.find((c) => existsSync(join(dir, c))) ?? null;
}

/** App Router: a dir is a route when it holds a page.<ext>. */
function walkAppRouter(dir, rel, urlPath, routes) {
	const entries = readdirSync(join(dir, rel), { withFileTypes: true });
	for (const entry of entries) {
		if (entry.isFile() && PAGE_EXTS.some((ext) => entry.name === `page.${ext}`)) {
			routes.push({
				path: urlPath || '/',
				file: `${rel}/${entry.name}`,
				...(hasDynamicSegment(urlPath) ? { dynamic: true } : {})
			});
			continue;
		}
		if (!entry.isDirectory()) continue;
		const seg = entry.name;
		// Not URL-visible subtrees: parallel slots render inside their parent,
		// _folders are private, (.)-style segments are interception copies.
		if (seg.startsWith('@') || seg.startsWith('_') || seg.startsWith('(.')) continue;
		// Route groups are organizational — the segment vanishes from the URL.
		const nextPath = /^\(.+\)$/.test(seg) ? urlPath : `${urlPath}/${seg}`;
		walkAppRouter(dir, `${rel}/${seg}`, nextPath, routes);
	}
}

/** Pages Router: every module is a route; _app/_document/api are not pages. */
function walkPagesRouter(dir, rel, urlPath, routes) {
	const entries = readdirSync(join(dir, rel), { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name.startsWith('_')) continue;
		if (entry.isDirectory()) {
			if (urlPath === '' && entry.name === 'api') continue;
			walkPagesRouter(dir, `${rel}/${entry.name}`, `${urlPath}/${entry.name}`, routes);
			continue;
		}
		const m = entry.name.match(/^(.+)\.(tsx|jsx|ts|js)$/);
		if (!m) continue;
		const base = m[1];
		const path = base === 'index' ? urlPath || '/' : `${urlPath}/${base}`;
		routes.push({
			path,
			file: `${rel}/${entry.name}`,
			...(hasDynamicSegment(path) ? { dynamic: true } : {})
		});
	}
}

function hasDynamicSegment(path) {
	return path.includes('[');
}

// ---------------------------------------------------------------------------
// Vite — best-effort react-router parse (ts-morph)
// ---------------------------------------------------------------------------

async function scanReactRouterRoutes(dir) {
	const files = grepRouterFiles(dir);
	if (files.length === 0) return { routes: [], source: 'none' };

	const { Project, SyntaxKind } = await loadTsMorph();
	const project = new Project({
		skipAddingFilesFromTsConfig: true,
		skipFileDependencyResolution: true
	});
	const routes = [];
	for (const file of files) {
		let sf;
		try {
			sf = project.addSourceFileAtPath(join(dir, file));
		} catch {
			continue; // unparseable file — best-effort means skipping it
		}
		collectJsxRoutes(sf, SyntaxKind, file, routes);
		collectRouterCallRoutes(sf, SyntaxKind, file, routes);
	}
	const unique = dedupe(routes);
	return { routes: unique, source: unique.length > 0 ? 'react-router' : 'none' };
}

/** Tracked sources that mention react-router primitives — git grep, like edits.js. */
function grepRouterFiles(dir) {
	try {
		const out = execFileSync(
			'git',
			[
				'grep',
				'-l',
				'-E',
				'<Route[ >/]|create(Browser|Hash|Memory)Router',
				'--',
				'*.tsx',
				'*.jsx',
				'*.ts',
				'*.js'
			],
			{ cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }
		)
			.toString()
			.trim();
		return out.split('\n').filter(Boolean);
	} catch {
		return []; // git grep exits 1 on no match
	}
}

/** <Route path="…"> trees, including nested relative paths and index routes. */
function collectJsxRoutes(sf, SyntaxKind, file, routes) {
	const openings = [
		...sf.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
		...sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)
	].filter((el) => el.getTagNameNode().getText() === 'Route');

	for (const el of openings) {
		const ownPath = jsxStringAttr(el, 'path');
		const isIndex = el.getAttribute('index') !== undefined;
		if (ownPath === null && !isIndex) continue; // pathless layout route — children carry the URL
		// Element routes only: a layout-with-children <Route path> is not itself
		// a page, but listing it is still useful and navigable, so keep it.
		const full = joinRoutePaths(jsxAncestorPath(el, SyntaxKind), ownPath ?? '');
		routes.push({
			path: full,
			file,
			...(isDynamicRouterPath(full) ? { dynamic: true } : {})
		});
	}
}

/** Accumulated path of enclosing <Route> elements, outermost first. */
function jsxAncestorPath(el, SyntaxKind) {
	const segments = [];
	let node = el.getParent();
	while (node) {
		if (node.getKind() === SyntaxKind.JsxElement) {
			const opening = node.getOpeningElement();
			if (opening.getTagNameNode().getText() === 'Route') {
				const p = jsxStringAttr(opening, 'path');
				if (p !== null) segments.unshift(p);
			}
		}
		node = node.getParent();
	}
	return segments.reduce((acc, seg) => joinRoutePaths(acc, seg), '');
}

function jsxStringAttr(el, name) {
	const attr = el.getAttribute(name);
	const init = attr?.getInitializer?.();
	if (!init) return null;
	// path="…" or path={'…'}
	const text = init.getText().trim();
	const m = text.match(/^\{?\s*(['"`])(.*)\1\s*\}?$/s);
	return m ? m[2] : null;
}

/** createBrowserRouter([{ path, children: […] }]) object trees. */
function collectRouterCallRoutes(sf, SyntaxKind, file, routes) {
	const calls = sf
		.getDescendantsOfKind(SyntaxKind.CallExpression)
		.filter((c) => /^create(Browser|Hash|Memory)Router$/.test(c.getExpression().getText()));
	for (const call of calls) {
		const arg = call.getArguments()[0];
		if (!arg || arg.getKind() !== SyntaxKind.ArrayLiteralExpression) continue;
		walkRouteObjects(arg, SyntaxKind, '', file, routes);
	}
}

function walkRouteObjects(arrayLiteral, SyntaxKind, parentPath, file, routes) {
	for (const el of arrayLiteral.getElements()) {
		if (el.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;
		const pathProp = el.getProperty('path');
		const init = pathProp?.getInitializer?.();
		const own =
			init && (init.getKind() === SyntaxKind.StringLiteral || init.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral)
				? init.getLiteralText()
				: null;
		const isIndex = el.getProperty('index') !== undefined;
		const full = own !== null ? joinRoutePaths(parentPath, own) : parentPath;
		if (own !== null || isIndex) {
			routes.push({
				path: full || '/',
				file,
				...(isDynamicRouterPath(full) ? { dynamic: true } : {})
			});
		}
		const children = el.getProperty('children')?.getInitializer?.();
		if (children && children.getKind() === SyntaxKind.ArrayLiteralExpression) {
			walkRouteObjects(children, SyntaxKind, full, file, routes);
		}
	}
}

/** react-router semantics: absolute child paths replace, relative ones nest. */
function joinRoutePaths(parent, child) {
	if (child.startsWith('/')) return normalizeRoute(child);
	if (!child) return normalizeRoute(parent || '/');
	return normalizeRoute(`${parent === '/' ? '' : parent}/${child}`);
}

function normalizeRoute(path) {
	const out = `/${path}`.replace(/\/+/g, '/');
	return out.length > 1 ? out.replace(/\/$/, '') : out;
}

function isDynamicRouterPath(path) {
	return path.includes(':') || path.includes('*');
}

function dedupe(routes) {
	const seen = new Map();
	for (const r of routes) if (!seen.has(r.path)) seen.set(r.path, r);
	return [...seen.values()];
}
