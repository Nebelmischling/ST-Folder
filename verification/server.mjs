/**
 * Minimal static server for the Character Folders verification harness.
 *
 * It serves:
 *  - the harness page itself,
 *  - the **real** extension files from the repository root (the root *is* the extension),
 *  - the real jQuery / jQuery UI / Font Awesome assets from a SillyTavern checkout
 *    (found via `$ST_ROOT`, next to the repo, or above it),
 *  - stubbed core modules at the exact URLs the extension imports.
 *
 * Usage: `node verification/server.mjs` (or import `startServer()` from checks.mjs).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const REPO_ROOT = path.resolve(HERE, '..');
// The repository root is the extension itself: SillyTavern clones the repo into
// public/scripts/extensions/third-party/<repo>/ and expects manifest.json right there.
const EXTENSION_DIR = REPO_ROOT;
const STUB_DIR = path.join(HERE, 'stubs');

/**
 * Locates a SillyTavern checkout, so the browser gets exactly the libraries it gets
 * inside SillyTavern. Search order: `$ST_ROOT`, directories next to/above the repo
 * (the project may itself live inside a checkout), then the repo itself.
 * @returns {string|null} Path to a SillyTavern root, or null when none was found
 */
function findStRoot() {
    const candidates = [process.env.ST_ROOT];
    let dir = REPO_ROOT;
    for (let level = 0; level < 6; level++) {
        dir = path.dirname(dir);
        candidates.push(path.join(dir, 'SillyTavern-release'), path.join(dir, 'SillyTavern'), dir);
    }
    candidates.push(path.join(REPO_ROOT, 'SillyTavern-release'), path.join(REPO_ROOT, 'SillyTavern'));

    for (const candidate of candidates) {
        if (candidate && fs.existsSync(path.join(candidate, 'public', 'lib', 'jquery-3.5.1.min.js'))) {
            return candidate;
        }
    }
    return null;
}

const ST_ROOT = findStRoot();

/** @type {Record<string, string>} */
const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
};

/**
 * Resolves a request URL to a file on disk.
 * @param {string} urlPath Request path (without query string)
 * @returns {string|null} Absolute file path, or null when the path is not served
 */
function resolveFile(urlPath) {
    if (urlPath === '/' || urlPath === '/harness.html') {
        return path.join(HERE, 'harness.html');
    }

    if (urlPath === '/script.js') {
        return path.join(STUB_DIR, 'script.js');
    }

    // Browsers request this automatically; without it every run logs a 404.
    if (urlPath === '/favicon.ico') {
        return path.join(HERE, 'favicon.ico');
    }

    if (urlPath === '/scripts/utils.js' || urlPath === '/scripts/i18n.js') {
        return path.join(STUB_DIR, path.basename(urlPath));
    }

    const extensionPrefix = '/scripts/extensions/third-party/character-folders/';
    if (urlPath.startsWith(extensionPrefix)) {
        return path.join(EXTENSION_DIR, urlPath.slice(extensionPrefix.length));
    }

    if (urlPath.startsWith('/lib/')) {
        return ST_ROOT ? path.join(ST_ROOT, 'public', 'lib', urlPath.slice('/lib/'.length)) : null;
    }

    if (urlPath.startsWith('/css/')) {
        return ST_ROOT ? path.join(ST_ROOT, 'public', 'css', urlPath.slice('/css/'.length)) : null;
    }

    if (urlPath.startsWith('/webfonts/')) {
        return ST_ROOT ? path.join(ST_ROOT, 'public', 'webfonts', urlPath.slice('/webfonts/'.length)) : null;
    }

    return null;
}

/**
 * Starts the harness server.
 * @param {number} [port=8123] Port
 * @returns {Promise<{server: http.Server, url: string}>} Server handle and base URL
 */
export function startServer(port = 8123) {
    if (!ST_ROOT) {
        console.warn('WARNING: no SillyTavern checkout found (jQuery, jQuery UI and Font Awesome will 404).');
        console.warn('Set ST_ROOT to a SillyTavern directory, e.g. ST_ROOT=/path/to/SillyTavern');
    }

    const server = http.createServer((request, response) => {
        const urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const filePath = resolveFile(urlPath);

        if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            response.writeHead(404, { 'Content-Type': 'text/plain' });
            response.end(`Not found: ${urlPath}`);
            return;
        }

        response.writeHead(200, {
            'Content-Type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        response.end(fs.readFileSync(filePath));
    });

    return new Promise(resolve => {
        server.listen(port, '127.0.0.1', () => {
            resolve({ server, url: `http://127.0.0.1:${port}` });
        });
    });
}

if (import.meta.filename === process.argv[1]) {
    const { url } = await startServer();
    console.log(`Harness running at ${url}`);
}
