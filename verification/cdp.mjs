/**
 * Dependency-free browser driver for the verification harness.
 *
 * Uses only Node built-ins (`fetch`, global `WebSocket`, `child_process`) and the
 * Chrome DevTools Protocol, so the checks need **no** `npm install` and no
 * Playwright package. It exposes a small Playwright-like facade (the subset of
 * methods `checks.mjs` uses).
 *
 * Interaction uses real CDP input events (`Input.dispatchMouseEvent`), so the
 * events are trusted and jQuery UI's drag & drop behaves exactly as with a real
 * mouse.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Candidate browser binaries, in order of preference. */
function browserCandidates() {
    const local = process.env.LOCALAPPDATA ?? '';
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    return [
        path.join(local, 'ms-playwright', 'chromium-1228', 'chrome-win64', 'chrome.exe'),
        path.join(local, 'ms-playwright', 'chromium_headless_shell-1228', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
        path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
}

/**
 * Finds a usable browser binary.
 * @returns {string} Absolute path to the browser executable
 * @throws {Error} When no browser is found
 */
function findBrowser() {
    for (const candidate of browserCandidates()) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error('No Chrome/Chromium/Edge binary found. Set CHROME_PATH to override.');
}

/**
 * Minimal CDP connection over a WebSocket.
 */
class Connection {
    /**
     * @param {string} url DevTools websocket URL
     */
    constructor(url) {
        this.url = url;
        this.nextId = 1;
        this.pending = new Map();
        this.listeners = new Map();
        this.socket = null;
    }

    /**
     * Opens the websocket.
     * @returns {Promise<Connection>} This connection
     */
    async open() {
        this.socket = new WebSocket(this.url);
        await new Promise((resolve, reject) => {
            const onOpen = () => { cleanup(); resolve(); };
            const onError = event => { cleanup(); reject(new Error(`CDP socket error: ${event?.message ?? 'unknown'}`)); };
            const cleanup = () => {
                this.socket.removeEventListener('open', onOpen);
                this.socket.removeEventListener('error', onError);
            };
            this.socket.addEventListener('open', onOpen);
            this.socket.addEventListener('error', onError);
        });

        this.socket.addEventListener('message', event => {
            let message = null;
            try {
                message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
            } catch {
                return;
            }

            if (message.id && this.pending.has(message.id)) {
                const { resolve, reject } = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error) {
                    reject(new Error(`${message.error.message} (${message.error.code})`));
                } else {
                    resolve(message.result ?? {});
                }
                return;
            }

            if (message.method) {
                for (const listener of this.listeners.get(message.method) ?? []) {
                    listener(message.params ?? {});
                }
            }
        });

        return this;
    }

    /**
     * Sends a CDP command.
     * @param {string} method CDP method
     * @param {object} [params] Parameters
     * @returns {Promise<object>} Result
     */
    send(method, params = {}) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.socket.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`CDP timeout for ${method}`));
                }
            }, 30000);
        });
    }

    /**
     * Subscribes to a CDP event.
     * @param {string} method Event name
     * @param {(params: object) => void} handler Handler
     * @returns {void}
     */
    on(method, handler) {
        if (!this.listeners.has(method)) {
            this.listeners.set(method, []);
        }
        this.listeners.get(method).push(handler);
    }

    /**
     * Closes the websocket.
     * @returns {void}
     */
    close() {
        try {
            this.socket?.close();
        } catch {
            // ignore
        }
    }
}

/**
 * A page with the subset of the Playwright API the checks use.
 */
class Page {
    /**
     * @param {Connection} connection CDP connection bound to the page target
     */
    constructor(connection) {
        this.connection = connection;
        this.consoleErrors = [];
        this.mousePosition = { x: 0, y: 0 };
        this.loaded = false;

        connection.on('Page.loadEventFired', () => { this.loaded = true; });
        connection.on('Runtime.consoleAPICalled', params => {
            if (params.type === 'error') {
                this.consoleErrors.push((params.args ?? []).map(arg => arg.value ?? arg.description ?? '').join(' '));
            }
        });
        connection.on('Runtime.exceptionThrown', params => {
            const details = params.exceptionDetails ?? {};
            this.consoleErrors.push(details.exception?.description ?? details.text ?? 'exception');
        });
        connection.on('Log.entryAdded', params => {
            if (params.entry?.level === 'error') {
                this.consoleErrors.push(`${params.entry.text ?? 'log error'}${params.entry.url ? ` <${params.entry.url}>` : ''}`);
            }
        });
    }

    /**
     * Enables the required domains and sets the viewport.
     * @param {object} [options] Options
     * @param {{width: number, height: number}} [options.viewport] Viewport size
     * @returns {Promise<void>} Resolves when ready
     */
    async init({ viewport = { width: 1280, height: 900 } } = {}) {
        this.viewport = viewport;
        await this.connection.send('Page.enable');
        await this.connection.send('Runtime.enable');
        await this.connection.send('Log.enable');
        await this.connection.send('Emulation.setDeviceMetricsOverride', {
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: 1,
            mobile: false,
        });
    }

    /**
     * Restores the configured viewport after a temporary override.
     * @returns {Promise<void>} Resolves when restored
     */
    async resetViewport() {
        await this.connection.send('Emulation.setDeviceMetricsOverride', {
            width: this.viewport.width,
            height: this.viewport.height,
            deviceScaleFactor: 1,
            mobile: false,
        });
    }

    /**
     * Navigates to a URL and waits for the load event.
     * @param {string} url URL
     * @returns {Promise<void>} Resolves after load
     */
    async goto(url) {
        this.loaded = false;
        await this.connection.send('Page.navigate', { url });
        const deadline = Date.now() + 20000;
        while (!this.loaded && Date.now() < deadline) {
            await delay(50);
        }
    }

    /**
     * Evaluates a function or expression inside the page.
     * @param {Function|string} fn Function or expression
     * @param {...any} args Arguments passed to the function
     * @returns {Promise<any>} The (by-value) result
     */
    async evaluate(fn, ...args) {
        const expression = typeof fn === 'function'
            ? `(${fn.toString()})(${args.map(argument => JSON.stringify(argument)).join(',')})`
            : String(fn);
        const result = await this.connection.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true,
        });
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluate failed');
        }
        return result.result?.value;
    }

    /**
     * Waits for a fixed amount of time.
     * @param {number} ms Milliseconds
     * @returns {Promise<void>} Resolves after the delay
     */
    async waitForTimeout(ms) {
        await delay(ms);
    }

    /**
     * Polls an expression until it is truthy.
     * @param {Function|string} fn Predicate
     * @param {any} [arg] Argument for the predicate
     * @param {object} [options] Options
     * @param {number} [options.timeout] Timeout in ms
     * @returns {Promise<void>} Resolves when truthy, rejects on timeout
     */
    async waitForFunction(fn, arg, { timeout = 15000 } = {}) {
        const deadline = Date.now() + timeout;
        let lastError = null;
        while (Date.now() < deadline) {
            try {
                if (await this.evaluate(fn, arg)) {
                    return;
                }
            } catch (error) {
                lastError = error;
            }
            await delay(50);
        }
        throw new Error(`waitForFunction timed out${lastError ? `: ${lastError.message}` : ''}`);
    }

    /**
     * Waits until an element exists and has a non-zero box.
     * @param {string} selector CSS selector
     * @param {object} [options] Options
     * @returns {Promise<{boundingBox: () => Promise<{x: number, y: number, width: number, height: number}>}>} Element handle
     */
    async waitForSelector(selector, options = {}) {
        await this.waitForFunction(sel => {
            const element = document.querySelector(sel);
            if (!element) {
                return false;
            }
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
        }, selector, options);
        return {
            boundingBox: () => this.boundingBox(selector),
        };
    }

    /**
     * Returns the bounding box of an element.
     * @param {string} selector CSS selector
     * @returns {Promise<{x: number, y: number, width: number, height: number}>} Box
     */
    async boundingBox(selector) {
        const box = await this.evaluate(sel => {
            const element = document.querySelector(sel);
            if (!element) {
                return null;
            }
            const rect = element.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }, selector);
        if (!box) {
            throw new Error(`No element for selector ${selector}`);
        }
        return box;
    }

    /**
     * Polls for an element (handle-like).
     * @param {string} selector CSS selector
     * @returns {Promise<object>} Element handle
     */
    async $(selector) {
        return this.waitForSelector(selector);
    }

    /**
     * Evaluates a function with all matching elements.
     * @param {string} selector CSS selector
     * @param {Function} fn Function receiving an array of elements
     * @returns {Promise<any>} Result
     */
    async $$eval(selector, fn) {
        return this.evaluate((sel, source) => {
            // eslint-disable-next-line no-eval
            const callback = eval(`(${source})`);
            return callback(Array.from(document.querySelectorAll(sel)));
        }, selector, fn.toString());
    }

    /**
     * Evaluates a function with the first matching element.
     * @param {string} selector CSS selector
     * @param {Function} fn Function receiving the element
     * @returns {Promise<any>} Result
     */
    async $eval(selector, fn) {
        return this.evaluate((sel, source) => {
            // eslint-disable-next-line no-eval
            const callback = eval(`(${source})`);
            return callback(document.querySelector(sel));
        }, selector, fn.toString());
    }

    /**
     * Clicks an element in its center.
     * @param {string} selector CSS selector
     * @returns {Promise<void>} Resolves after the click
     */
    async click(selector) {
        const box = await this.boundingBox(selector);
        await this.mouseClick(box.x + box.width / 2, box.y + box.height / 2, 1);
    }

    /**
     * Double clicks an element in its center.
     * @param {string} selector CSS selector
     * @returns {Promise<void>} Resolves after the double click
     */
    async dblclick(selector) {
        const box = await this.boundingBox(selector);
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await this.mouseClick(x, y, 1);
        await this.mouseClick(x, y, 2);
    }

    /**
     * Replaces the value of an input or textarea.
     * @param {string} selector CSS selector
     * @param {string} value New value
     * @returns {Promise<void>} Resolves after the value was set
     */
    async fill(selector, value) {
        await this.evaluate((sel, text) => {
            const element = document.querySelector(sel);
            if (!element) {
                throw new Error(`No element for selector ${sel}`);
            }
            element.focus();
            element.value = text;
            element.dispatchEvent(new Event('input', { bubbles: true }));
        }, selector, value);
    }

    /**
     * Sends a key press.
     * @param {string} key Key name, e.g. 'Enter'
     * @returns {Promise<void>} Resolves after the key events
     */
    async press(key) {
        const codes = { Enter: 13, Escape: 27, Tab: 9 };
        const virtualKey = codes[key] ?? 0;
        await this.connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
        await this.connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey });
    }

    /**
     * Mouse facade.
     * @returns {{move: Function, down: Function, up: Function}} Mouse helpers
     */
    get mouse() {
        return {
            move: async (x, y, options = {}) => {
                const steps = Math.max(1, Number(options.steps) || 1);
                const start = { ...this.mousePosition };
                for (let step = 1; step <= steps; step++) {
                    const intermediateX = start.x + ((x - start.x) * step) / steps;
                    const intermediateY = start.y + ((y - start.y) * step) / steps;
                    await this.connection.send('Input.dispatchMouseEvent', {
                        type: 'mouseMoved',
                        x: intermediateX,
                        y: intermediateY,
                        button: 'none',
                        buttons: 0,
                    });
                }
                this.mousePosition = { x, y };
            },
            down: async () => {
                await this.connection.send('Input.dispatchMouseEvent', {
                    type: 'mousePressed',
                    x: this.mousePosition.x,
                    y: this.mousePosition.y,
                    button: 'left',
                    buttons: 1,
                    clickCount: 1,
                });
            },
            up: async () => {
                await this.connection.send('Input.dispatchMouseEvent', {
                    type: 'mouseReleased',
                    x: this.mousePosition.x,
                    y: this.mousePosition.y,
                    button: 'left',
                    buttons: 1,
                    clickCount: 1,
                });
            },
        };
    }

    /**
     * Full click via raw input events.
     * @param {number} x X coordinate
     * @param {number} y Y coordinate
     * @param {number} clickCount Click count
     * @returns {Promise<void>} Resolves after the click
     */
    async mouseClick(x, y, clickCount = 1) {
        await this.mouse.move(x, y);
        await this.connection.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount });
        await this.connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 1, clickCount });
    }

    /**
     * Captures a screenshot.
     * @param {object} options Options
     * @param {string} options.path Output file
     * @returns {Promise<void>} Resolves when written
     */
    async screenshot({ path: file }) {
        const result = await this.connection.send('Page.captureScreenshot', { format: 'png' });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    }

    /**
     * Captures a screenshot of a single element (via a clip region, so the page
     * layout is not disturbed).
     * @param {string} selector CSS selector
     * @param {object} options Options
     * @param {string} options.path Output file
     * @param {number} [options.scale] Scale factor
     * @returns {Promise<void>} Resolves when written
     */
    async screenshotElement(selector, { path: file, scale = 2 }) {
        const box = await this.boundingBox(selector);
        const result = await this.connection.send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
            clip: {
                x: Math.max(0, box.x),
                y: Math.max(0, box.y),
                width: box.width,
                height: box.height,
                scale,
            },
        });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    }
}

/**
 * Sleeps.
 * @param {number} ms Milliseconds
 * @returns {Promise<void>} Resolves after the delay
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Launches a browser and opens one page.
 * @param {object} [options] Options
 * @param {number} [options.port] Remote debugging port
 * @param {boolean} [options.headless] Whether to run headless
 * @param {string} [options.executablePath] Browser binary override
 * @returns {Promise<{page: Page, close: () => Promise<void>}>} Browser handle
 */
export async function launchBrowser({ port = 9333, headless = true, executablePath } = {}) {
    const binary = executablePath ?? process.env.CHROME_PATH ?? findBrowser();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cdp-'));

    const args = [
        headless ? '--headless=new' : '--new-window',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--window-size=1280,900',
        'about:blank',
    ];

    const child = spawn(binary, args, { stdio: 'ignore' });
    let version = null;

    for (let attempt = 0; attempt < 100; attempt++) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/json/version`);
            version = await response.json();
            break;
        } catch {
            await delay(100);
        }
    }

    if (!version) {
        child.kill();
        throw new Error(`Browser did not expose a DevTools endpoint on port ${port}`);
    }

    let target = null;
    try {
        const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
        target = await response.json();
    } catch {
        const response = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`);
        target = await response.json();
    }

    const connection = await new Connection(target.webSocketDebuggerUrl).open();
    const page = new Page(connection);
    await page.init();

    return {
        page,
        version,
        async close() {
            connection.close();
            child.kill();
            await delay(150);
            try {
                fs.rmSync(userDataDir, { recursive: true, force: true });
            } catch {
                // ignore locked temp profiles
            }
        },
    };
}
