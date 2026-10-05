/**
 * Test doubles for the SillyTavern core modules that the Character Folders
 * extension imports. They only implement the contract the extension relies on:
 *
 *  - `/script.js`      : characters, the entity filter chain, printCharacters*
 *  - `/scripts/utils.js`: escapeHtml
 *  - `/scripts/i18n.js` : t / translate
 *
 * `renderList()` mimics the core character list pipeline: entities -> registered
 * filter functions (including the extension's own filter) -> DOM cards, followed
 * by the CHARACTER_PAGE_LOADED event at the end, exactly like script.js:1067.
 */

/** @type {Array<{name: string, avatar: string, fav?: boolean}>} */
export const characters = [];

/** Minimal stand-in for `EventEmitter` used by ST. */
class MiniEmitter {
    constructor() {
        this.handlers = new Map();
    }

    /**
     * @param {string} event Event name
     * @param {Function} handler Handler
     * @returns {void}
     */
    on(event, handler) {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, []);
        }
        this.handlers.get(event).push(handler);
    }

    /**
     * @param {string} event Event name
     * @param {...any} args Arguments
     * @returns {void}
     */
    emit(event, ...args) {
        for (const handler of this.handlers.get(event) ?? []) {
            handler(...args);
        }
    }
}

export const eventSource = new MiniEmitter();

export const event_types = {
    APP_READY: 'app_ready',
    SETTINGS_LOADED_AFTER: 'settings_loaded_after',
    CHARACTER_PAGE_LOADED: 'character_page_loaded',
    CHARACTER_RENAMED: 'character_renamed',
    CHARACTER_DUPLICATED: 'character_duplicated',
    CHARACTER_DELETED: 'characterDeleted',
};

/**
 * Stand-in for the core `FilterHelper` instance of the character list. Only the
 * pieces the extension touches are implemented: `filterFunctions` (extended by
 * the extension) and a reducer-based `applyFilters`.
 */
export const entitiesFilter = {
    filterFunctions: {},
    /**
     * @param {Array<object>} data Entity list
     * @returns {Array<object>} Filtered entity list
     */
    applyFilters(data) {
        return Object.values(this.filterFunctions).reduce((current, fn) => fn(current), data);
    },
    /**
     * @returns {boolean} Always "no filter state" in the harness
     */
    getFilterData() {
        return false;
    },
};

/** @type {number} */
export let printCount = 0;

/**
 * Replaces the character list with the current filter result.
 * @returns {void}
 */
function renderList() {
    const list = document.getElementById('rm_print_characters_block');
    if (!list) {
        return;
    }

    const entities = characters.map((item, index) => ({ item, id: index, type: 'character' }));
    const filtered = entitiesFilter.applyFilters(entities);

    list.innerHTML = '';
    for (const entity of filtered) {
        const card = document.createElement('div');
        card.className = 'character_select entity_block';
        card.setAttribute('data-chid', String(entity.id));
        card.innerHTML = '<div class="avatar"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt=""></div><span class="ch_name"></span>';
        card.querySelector('.ch_name').textContent = entity.item.name;
        card.querySelector('.ch_name').setAttribute('title', entity.item.avatar);
        list.appendChild(card);
    }

    eventSource.emit(event_types.CHARACTER_PAGE_LOADED);
}

/**
 * Simulates `printCharacters` (with full refresh).
 * @returns {void}
 */
export function printCharacters() {
    printCount++;
    renderList();
}

/**
 * Simulates `printCharactersDebounced` (no delay in the harness).
 * @returns {void}
 */
export function printCharactersDebounced() {
    printCount++;
    renderList();
}

/** @type {number} How often the immediate save was called. */
let immediateSaveCount = 0;

/**
 * Simulates the immediate settings save (`script.js:8051`), which the extension uses
 * for content changes so a quick reload cannot lose them.
 * @returns {Promise<void>} Resolves immediately
 */
export async function saveSettings() {
    immediateSaveCount++;
    if (globalThis.__cf) {
        globalThis.__cf.immediateSaves = immediateSaveCount;
    }
}

/**
 * @returns {number} How often the immediate save ran
 */
export function __immediateSaveCount() {
    return immediateSaveCount;
}

/**
 * Seeds the fake character list and renders it.
 * @param {Array<{name: string, avatar: string}>} list Characters
 * @returns {void}
 */
export function __seedCharacters(list) {
    characters.length = 0;
    characters.push(...list);
    printCharacters();
}

/**
 * @returns {number} How often the character list was reprinted
 */
export function __printCount() {
    return printCount;
}
