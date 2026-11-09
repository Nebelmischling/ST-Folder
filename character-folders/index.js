/**
 * Character Folders — SillyTavern UI extension.
 *
 * Adds a nested folder tree to the Character Management panel. Every character
 * lives in **exactly one** folder (or in none), folders can be nested freely and
 * characters/folders are moved by drag & drop.
 *
 * Design notes:
 * - No core file is modified. The extension only injects DOM into the character
 *   panel and registers one extra predicate in `entitiesFilter.filterFunctions`,
 *   which is how the built-in filter chain is extended without patching it.
 * - All folder data lives in `extension_settings['character-folders']`, so it is
 *   stored in the user's `settings.json` and part of every settings backup.
 * - All folder rules live in `folder-store.js` (pure, unit tested).
 */

import {
    characters,
    entitiesFilter,
    printCharacters,
    printCharactersDebounced,
    saveSettings,
} from '../../../../script.js';
import { escapeHtml } from '../../../utils.js';
import { t } from '../../../i18n.js';

import {
    MAX_NAME_LENGTH,
    createEmptyState,
    normalizeState,
    createFolder,
    renameFolder,
    setFolderColor,
    setFolderCollapsed,
    deleteFolder,
    moveFolder,
    assignCharacter,
    copyCharacterAssignment,
    getCharacterFolderId,
    getCharacterCount,
    getUnassignedAvatars,
    isCharacterInFolder,
    pruneAssignments,
    renameCharacterAvatar,
    getChildren,
    getFolderPath,
    getDescendantIds,
    serializeState,
    parseState,
    getFolder,
} from './folder-store.js';

/** Key used inside `extension_settings`. */
const MODULE_NAME = 'character-folders';

/** Id of the injected panel. */
const PANEL_ID = 'cf_panel';

/** Log prefix. */
const LOG = '[Character Folders]';

/** Result codes for the folder action popup (matching POPUP_RESULT.CUSTOM1..7). */
const FOLDER_ACTION = {
    NEW_SUBFOLDER: 1001,
    RENAME: 1002,
    COLOR: 1003,
    MOVE_UP: 1004,
    MOVE_DOWN: 1005,
    MOVE_TO_ROOT: 1006,
    DELETE: 1007,
};

/** Matches 3- or 6-digit hex colors (the forms an `<input type="color">` can show). */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Normalises a stored folder color to what a color picker accepts (always 6 digits).
 * @param {string} value Stored color value
 * @returns {string} `#rrggbb`, or an empty string when the value is not a usable color
 */
function normalizeColor(value) {
    if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
        return '';
    }

    if (value.length === 4) {
        const [, red, green, blue] = value;
        return `#${red}${red}${green}${green}${blue}${blue}`.toLowerCase();
    }

    return value.toLowerCase();
}

/**
 * @type {ReturnType<typeof createEmptyState>|null}
 * The live folder state (a reference into `extension_settings`).
 */
let state = null;

/** Whether the custom list filter is registered. */
let filterRegistered = false;

/** Id of the folder that is currently being renamed inline (if any). */
let renamingFolderId = null;

/**
 * Number of known characters when the panel was last fully rendered. SillyTavern
 * loads the character list *after* the extensions, so the first list render must
 * rebuild the panel; later renders (search, paging, sorting) must not.
 * @type {number}
 */
let lastRenderedAvatarCount = -1;

/**
 * Characters selected for bulk moving (avatar file names). Kept across pages so a
 * selection can span several pages of the character list.
 * @type {Set<string>}
 */
const selection = new Set();

/** Avatar of the last selection click, used as the anchor for shift ranges. */
let lastSelectedAvatar = null;

/**
 * Info about the last bulk move, so it can be undone.
 * @type {{targetFolderId: string|null, entries: {avatar: string, previous: string|null}[]}|null}
 */
let lastBulkMove = null;

/**
 * Returns the SillyTavern context, or null when the app is not ready yet.
 * @returns {object|null} ST context object
 */
function ctx() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

/**
 * Shows a toast, tolerating a missing toastr (e.g. in tests).
 * @param {'success'|'info'|'warning'|'error'} type Toast type
 * @param {string} message Message
 * @returns {void}
 */
function toast(type, message) {
    if (typeof toastr === 'undefined') {
        console.log(LOG, type, message);
        return;
    }
    toastr[type]?.(message);
}

/**
 * All character avatars currently known to the client. Empty until the core has
 * loaded the character list (which happens *after* extensions are initialised).
 * @returns {string[]} Avatar file names
 */
function knownAvatars() {
    return (characters ?? [])
        .map(character => character?.avatar)
        .filter(avatar => typeof avatar === 'string' && avatar.length > 0 && avatar !== 'none');
}

/**
 * Counts assignments whose character no longer exists. Used to *offer* a cleanup,
 * never to delete anything automatically: extensions are initialised before the
 * character list is loaded (script.js:747 runs `initExtensions()` before
 * `getCharacters()` at script.js:759), so an empty known-avatar list does **not**
 * mean "no characters exist".
 * @returns {number} Number of stale assignments
 */
function countStaleAssignments() {
    if (!state) {
        return 0;
    }
    const known = new Set(knownAvatars());
    if (known.size === 0) {
        return 0;
    }
    return Object.keys(state.assignments).filter(avatar => !known.has(avatar)).length;
}

/**
 * Persists the state into the settings file.
 * @param {object} [options] Options
 * @param {boolean} [options.immediate=true] Write right away instead of using the debounce.
 *   Only cosmetic UI state (panel collapsed, options toggles) uses the debounced path; every
 *   content change is written immediately so that a quick page reload cannot lose it.
 * @returns {void}
 */
function saveState({ immediate = true } = {}) {
    const context = ctx();
    if (!context || !state) {
        return;
    }

    // Keep the live reference in sync first: everything else reads from here.
    context.extensionSettings[MODULE_NAME] = state;

    if (immediate && typeof saveSettings === 'function') {
        saveSettings().catch(error => console.error(LOG, 'Could not save the settings file', error));
        return;
    }

    context.saveSettingsDebounced();
}

/**
 * Loads the state from `extension_settings`, creating it when missing.
 * @param {object} context ST context
 * @returns {void}
 */
function loadState(context) {
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = createEmptyState();
    }
    state = normalizeState(context.extensionSettings[MODULE_NAME]);
    context.extensionSettings[MODULE_NAME] = state;
}

/* -------------------------------------------------------------------------- */
/* Character list integration                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The extra list filter. Runs last in the built-in filter chain and therefore
 * only narrows down what the core filters already allowed.
 * @param {Array<{type: string, item: object}>} data Entity list
 * @returns {Array<{type: string, item: object}>} Filtered entity list
 */
function folderFilter(data) {
    if (!state || !Array.isArray(data)) {
        return data;
    }

    const openFolderId = state.ui.openFolderId ?? null;
    const includeSubfolders = state.ui.includeSubfolders !== false;

    // Pure pass-through fast path: root view showing everything, core tag folders visible.
    if (openFolderId === null && state.ui.showAllInRoot && !state.ui.hideTagFolders) {
        return data;
    }

    return data.filter(entity => {
        if (entity?.type === 'tag') {
            return !state.ui.hideTagFolders;
        }
        if (entity?.type !== 'character') {
            return true;
        }

        const avatar = entity.item?.avatar;
        if (typeof avatar !== 'string' || avatar.length === 0 || avatar === 'none') {
            return true;
        }

        if (openFolderId === null) {
            // Root view: either everything, or only the characters without a folder.
            return state.ui.showAllInRoot ? true : getCharacterFolderId(state, avatar) === null;
        }

        return isCharacterInFolder(state, avatar, openFolderId, { includeSubfolders });
    });
}

/**
 * Registers the folder filter in the character list filter chain.
 * @returns {boolean} Whether the filter is active
 */
function registerFilter() {
    if (filterRegistered) {
        return true;
    }

    if (!entitiesFilter || typeof entitiesFilter.filterFunctions !== 'object') {
        console.warn(LOG, 'Could not hook into the character list filter. The folder tree still works, but the character list will not be filtered.');
        return false;
    }

    entitiesFilter.filterFunctions[MODULE_NAME] = folderFilter;
    filterRegistered = true;
    return true;
}

/**
 * Reprints the character list.
 * @param {object} [options] Options
 * @param {boolean} [options.resetPage=false] Whether to jump back to the first page
 * @returns {void}
 */
function refreshList({ resetPage = false } = {}) {
    if (resetPage) {
        printCharacters(true);
    } else {
        printCharactersDebounced();
    }
}

/**
 * Saves, re-renders the panel and refreshes the list.
 * @param {object} [options] Options
 * @param {boolean} [options.relist=true] Whether the character list should be reprinted
 * @param {boolean} [options.resetPage=false] Whether to jump back to the first page
 * @param {boolean} [options.immediate=true] Whether the settings file is written right away
 * @returns {void}
 */
function commit({ relist = true, resetPage = false, immediate = true } = {}) {
    saveState({ immediate });
    renderPanel();
    if (relist) {
        refreshList({ resetPage });
    }
}

/* -------------------------------------------------------------------------- */
/* Panel DOM                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Creates the panel if it does not exist yet.
 * @returns {HTMLElement|null} The panel element
 */
function ensurePanel() {
    const container = document.getElementById('rm_characters_block');
    if (!container) {
        return null;
    }

    let panel = document.getElementById(PANEL_ID);
    if (panel) {
        return panel;
    }

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'cf-panel';
    panel.innerHTML = `
        <div class="cf-header">
            <i class="cf-panel-toggle menu_button fa-solid fa-chevron-down" title="${t`Collapse folder panel`}"></i>
            <span class="cf-title"><i class="fa-solid fa-folder-tree"></i> ${t`Folders`}</span>
            <span class="cf-spacer"></span>
            <i class="cf-new-folder menu_button fa-solid fa-folder-plus" title="${t`Create a new folder`}"></i>
            <i class="cf-options menu_button fa-solid fa-ellipsis" title="${t`Folder options`}"></i>
        </div>
        <div class="cf-selection cf-hidden"></div>
        <div class="cf-breadcrumb"></div>
        <div class="cf-tree"></div>
    `;

    const anchor = document.getElementById('charListFixedTop');
    if (anchor && anchor.parentElement === container) {
        anchor.insertAdjacentElement('afterend', panel);
    } else {
        container.prepend(panel);
    }

    bindPanelEvents(panel);
    return panel;
}

/**
 * Wires the static panel controls.
 * @param {HTMLElement} panel Panel element
 * @returns {void}
 */
function bindPanelEvents(panel) {
    panel.querySelector('.cf-new-folder')?.addEventListener('click', () => onNewFolder());
    panel.querySelector('.cf-options')?.addEventListener('click', () => onOpenOptions());
    panel.querySelector('.cf-panel-toggle')?.addEventListener('click', () => {
        if (!state) {
            return;
        }
        state.ui.panelCollapsed = !state.ui.panelCollapsed;
        commit({ relist: false, immediate: false });
    });

    // Selection bar
    panel.querySelector('.cf-selection')?.addEventListener('click', event => onSelectionBarClick(event));

    // Escape clears the selection (so folder clicks navigate again).
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && selection.size > 0 && document.getElementById(PANEL_ID)) {
            clearSelection();
        }
    });

    // Tree interactions are delegated, so re-rendering does not need re-binding.
    panel.addEventListener('click', event => onTreeClick(event));
    panel.addEventListener('dblclick', event => onTreeDoubleClick(event));
    panel.addEventListener('contextmenu', event => onTreeContextMenu(event));
}

/**
 * Renders header, breadcrumb and tree.
 * @returns {void}
 */
function renderPanel() {
    const panel = ensurePanel();
    if (!panel || !state) {
        return;
    }

    const total = knownAvatars().length;
    const unassigned = getUnassignedAvatars(state, knownAvatars()).length;

    panel.classList.toggle('cf-collapsed', state.ui.panelCollapsed === true);
    panel.querySelector('.cf-panel-toggle')?.classList.toggle('fa-chevron-down', !state.ui.panelCollapsed);
    panel.querySelector('.cf-panel-toggle')?.classList.toggle('fa-chevron-right', state.ui.panelCollapsed);
    panel.querySelector('.cf-title')?.setAttribute('title', t`${unassigned} of ${total} characters are not in a folder`);

    renderSelectionBar(panel);
    renderBreadcrumb(panel);
    renderTree(panel);
    lastRenderedAvatarCount = knownAvatars().length;
}

/**
 * Renders the selection bar that appears while characters are selected for moving.
 * @param {HTMLElement} panel Panel element
 * @returns {void}
 */
function renderSelectionBar(panel) {
    const bar = panel.querySelector('.cf-selection');
    if (!bar) {
        return;
    }

    // Nothing selected and nothing to undo -> no bar.
    if (selection.size === 0 && !lastBulkMove) {
        bar.innerHTML = '';
        bar.classList.add('cf-hidden');
        return;
    }

    // After a move the bar stays as an undo offer until it is dismissed.
    if (selection.size === 0 && lastBulkMove) {
        const targetName = lastBulkMove.targetFolderId
            ? escapeHtml(getFolder(state, lastBulkMove.targetFolderId)?.name ?? '')
            : t`Unfiled`;
        bar.innerHTML = [
            `<span class="cf-sel-count"><i class="fa-solid fa-rotate-left"></i> ${t`${lastBulkMove.entries.length} moved to "${targetName}"`}</span>`,
            `<span class="cf-spacer"></span>`,
            `<button type="button" class="menu_button cf-sel-undo"><i class="fa-solid fa-rotate-left"></i> ${t`Undo`}</button>`,
            `<button type="button" class="menu_button cf-sel-clear" title="${t`Dismiss`}"><i class="fa-solid fa-xmark"></i></button>`,
        ].join('');
        bar.classList.remove('cf-hidden');
        return;
    }

    const hint = state.ui.clickFolderMovesSelection !== false
        ? t`Click a folder below to move them there`
        : t`Use "Move to…" to pick a folder`;

    const parts = [
        `<span class="cf-sel-count"><i class="fa-solid fa-check-double"></i> ${t`${selection.size} selected`}</span>`,
        `<span class="cf-sel-hint">${hint}</span>`,
        `<span class="cf-spacer"></span>`,
        `<button type="button" class="menu_button cf-sel-move" title="${t`Pick a folder from a list`}"><i class="fa-solid fa-folder-open"></i> ${t`Move to…`}</button>`,
        `<button type="button" class="menu_button cf-sel-unfile" title="${t`Remove from any folder`}"><i class="fa-solid fa-inbox"></i> ${t`Unfile`}</button>`,
    ];

    if (lastBulkMove) {
        parts.push(`<button type="button" class="menu_button cf-sel-undo" title="${t`Undo the last move`}"><i class="fa-solid fa-rotate-left"></i> ${t`Undo`}</button>`);
    }

    parts.push(`<button type="button" class="menu_button cf-sel-all" title="${t`Select every character currently shown`}"><i class="fa-solid fa-check-double"></i> ${t`All shown`}</button>`);
    parts.push(`<button type="button" class="menu_button cf-sel-clear" title="${t`Clear the selection`}"><i class="fa-solid fa-xmark"></i></button>`);

    bar.innerHTML = parts.join('');
    bar.classList.remove('cf-hidden');
}

/**
 * Updates the selection visuals without rebuilding the tree: row highlight, the
 * "+N" badge and the selection bar. A full rebuild here would destroy and re-create
 * every jQuery UI widget on each click.
 * @returns {void}
 */
function renderSelectionState() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !state) {
        return;
    }

    const selecting = selection.size > 0 && state.ui.clickFolderMovesSelection !== false;
    for (const row of panel.querySelectorAll('.cf-row')) {
        row.classList.toggle('cf-movetarget', selecting);
        const badge = row.querySelector('.cf-move-hint');
        if (badge) {
            badge.textContent = `+${selection.size}`;
        }
    }

    renderSelectionBar(panel);
}

/**
 * Refreshes the "Unfiled" counter and the panel tooltip. Cheap enough to run after
 * every character-list render (search, paging, sorting).
 * @returns {void}
 */
function updateUnfiledCount() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !state) {
        return;
    }

    const avatars = knownAvatars();
    const unassigned = getUnassignedAvatars(state, avatars).length;
    const counter = panel.querySelector('.cf-row-unassigned .cf-count');
    if (counter) {
        counter.textContent = String(unassigned);
    }
    panel.querySelector('.cf-title')?.setAttribute('title', t`${unassigned} of ${avatars.length} characters are not in a folder`);
}

/**
 * Renders the breadcrumb of the currently opened folder.
 * @param {HTMLElement} panel Panel element
 * @returns {void}
 */
function renderBreadcrumb(panel) {
    const breadcrumb = panel.querySelector('.cf-breadcrumb');
    if (!breadcrumb) {
        return;
    }

    const openFolderId = state.ui.openFolderId ?? null;
    if (openFolderId === null) {
        breadcrumb.innerHTML = '';
        breadcrumb.classList.add('cf-hidden');
        return;
    }

    const path = getFolderPath(state, openFolderId);
    const parts = [`<span class="cf-crumb cf-crumb-root" data-folder-id="" title="${t`Back to the root level`}">${t`Folders`}</span>`];
    for (const folder of path) {
        parts.push(`<i class="cf-crumb-sep fa-solid fa-angle-right"></i>`);
        parts.push(`<span class="cf-crumb" data-folder-id="${escapeHtml(folder.id)}">${escapeHtml(folder.name)}</span>`);
    }

    breadcrumb.innerHTML = parts.join('');
    breadcrumb.classList.remove('cf-hidden');
}

/**
 * Collects the visible folders in display order. Descendants of collapsed folders
 * are skipped, like in any file tree.
 * @param {string|null} parentId Parent folder id, or null for the root
 * @param {number} depth Current depth
 * @param {Array<{folder: object, depth: number}>} out Collector
 * @returns {Array<{folder: object, depth: number}>} Visible folders
 */
function collectVisibleFolders(parentId, depth, out) {
    for (const folder of getChildren(state, parentId)) {
        out.push({ folder, depth });
        if (!folder.collapsed) {
            collectVisibleFolders(folder.id, depth + 1, out);
        }
    }
    return out;
}

/**
 * Renders the folder tree.
 * @param {HTMLElement} panel Panel element
 * @returns {void}
 */
function renderTree(panel) {
    const tree = panel.querySelector('.cf-tree');
    if (!tree) {
        return;
    }

    destroyTreeWidgets(panel);

    const avatars = knownAvatars();
    const unassigned = getUnassignedAvatars(state, avatars);
    const includeSubfolders = state.ui.includeSubfolders !== false;
    const openFolderId = state.ui.openFolderId ?? null;
    const selecting = selection.size > 0 && state.ui.clickFolderMovesSelection !== false;
    const moveBadge = `<span class="cf-move-hint" title="${t`Move the selection here`}">+${selection.size}</span>`;

    const rows = [`
        <div class="cf-row cf-row-unassigned${openFolderId === null ? ' cf-open' : ''}${selecting ? ' cf-movetarget' : ''}" data-folder-id="" data-root-row="unassigned" style="--cf-depth:0">
            <i class="cf-twisty cf-twisty-empty"></i>
            <i class="cf-folder-icon fa-solid fa-inbox"></i>
            <span class="cf-name">${t`Unfiled`}</span>
            ${moveBadge}
            <span class="cf-count" title="${t`Characters without a folder`}">${unassigned.length}</span>
            <i class="cf-row-menu fa-solid fa-ellipsis-vertical" title="${t`Folder actions`}"></i>
        </div>
    `];

    for (const { folder, depth } of collectVisibleFolders(null, 0, [])) {
        const count = includeSubfolders
            ? getCharacterCount(state, folder.id, { includeSubfolders: true })
            : getCharacterCount(state, folder.id);
        const children = getChildren(state, folder.id);
        const hasChildren = children.length > 0;
        const color = normalizeColor(folder.color);
        const colorStyle = color ? ` style="color:${color}"` : '';

        rows.push(`
            <div class="cf-row${openFolderId === folder.id ? ' cf-open' : ''}${folder.collapsed ? ' cf-collapsed' : ''}${selecting ? ' cf-movetarget' : ''}" data-folder-id="${escapeHtml(folder.id)}" data-cf-kind="folder" style="--cf-depth:${depth}">
                <i class="cf-twisty fa-solid fa-chevron-${folder.collapsed ? 'right' : 'down'}${hasChildren ? '' : ' cf-twisty-empty'}"></i>
                <i class="cf-folder-icon fa-solid ${folder.collapsed ? 'fa-folder' : 'fa-folder-open'}"${colorStyle}></i>
                <span class="cf-name">${escapeHtml(folder.name)}</span>
                ${moveBadge}
                <span class="cf-count" title="${t`Characters in this folder`}">${count}</span>
                <i class="cf-row-menu fa-solid fa-ellipsis-vertical" title="${t`Folder actions`}"></i>
            </div>
        `);
    }

    tree.innerHTML = rows.join('');
    wireTreeWidgets(panel);
}

/**
 * Destroys jQuery UI widgets attached to tree rows before the tree is replaced.
 * @param {HTMLElement} panel Panel element
 * @returns {void}
 */
function destroyTreeWidgets(panel) {
    for (const row of panel.querySelectorAll('.cf-row')) {
        destroyWidget(row, 'droppable');
        destroyWidget(row, 'draggable');
    }
}

/**
 * Destroys a jQuery UI widget if it is initialized, ignoring errors.
 * @param {Element} element Element
 * @param {'droppable'|'draggable'} widget Widget name
 * @returns {void}
 */
function destroyWidget(element, widget) {
    const $element = $(element);
    if (typeof $element[widget] !== 'function') {
        return;
    }
    try {
        if ($element[widget]('instance')) {
            $element[widget]('destroy');
        }
    } catch (error) {
        console.debug(LOG, `Could not destroy ${widget}`, error);
    }
}

/**
 * Makes folder rows draggable and droppable.
 * @param {HTMLElement} panel Panel element
 * @returns {void}
 */
function wireTreeWidgets(panel) {
    if (typeof $ === 'undefined' || typeof $.fn?.droppable !== 'function') {
        console.warn(LOG, 'jQuery UI drag & drop is unavailable. Use the folder action menu to move folders.');
        return;
    }

    const mobile = ctx()?.isMobile?.() === true;

    for (const row of panel.querySelectorAll('.cf-row')) {
        const $row = $(row);
        const folderId = row.getAttribute('data-folder-id') ?? '';
        const isFolderRow = folderId.length > 0;

        if (isFolderRow) {
            $row.draggable({
                helper: function () {
                    return $(this).clone().addClass('cf-drag-item cf-drag-helper').css('width', $(this).outerWidth());
                },
                appendTo: 'body',
                zIndex: 100001,
                revert: 'invalid',
                revertDuration: 120,
                distance: mobile ? 12 : 6,
                delay: mobile ? 200 : 0,
                cancel: '.cf-twisty, .cf-row-menu, .cf-name-input',
                start: function () {
                    $(this).addClass('cf-dragging');
                },
                stop: function () {
                    $(this).removeClass('cf-dragging');
                },
            });
        }

        $row.droppable({
            accept: acceptsDrag,
            hoverClass: 'cf-drop-hover',
            tolerance: 'pointer',
            drop: (event, ui) => {
                onDropOnFolder(row, getDragPayload(ui.draggable ?? ui.helper));
            },
        });
    }
}

/**
 * Reads the drag payload of an element. The payload is stored as HTML attributes
 * rather than jQuery `data`, because jQuery UI hands the *cloned helper* to the
 * `accept` and `drop` callbacks when a custom helper is used, and a clone does not
 * carry jQuery data.
 * @param {object|Element|undefined} element Draggable instance, jQuery object or DOM node
 * @returns {{kind: string, folderId?: string, avatar?: string}|null} Payload, or null when it is not one of ours
 */
function getDragPayload(element) {
    // Accepts a jQuery object, a plain DOM node or a jQuery UI draggable instance.
    const candidate = element?.jquery ? element : (element?.element ?? element);
    const $element = $(candidate ?? []);
    const kind = $element.attr?.('data-cf-kind');

    if (kind === 'folder') {
        return { kind, folderId: $element.attr('data-folder-id') ?? '' };
    }
    if (kind === 'character') {
        return { kind, avatar: $element.attr('data-cf-avatar') ?? '' };
    }
    return null;
}

/**
 * Drop acceptance test for `jQuery.ui.droppable`. Only elements that carry our own
 * drag payload are accepted, so foreign draggables (e.g. ST's own sortable widgets)
 * never trigger a folder drop.
 * @param {object|Element} draggable Draggable instance, helper or element
 * @returns {boolean} Whether the dragged element can be dropped on a folder row
 */
function acceptsDrag(draggable) {
    return getDragPayload(draggable) !== null;
}

/* -------------------------------------------------------------------------- */
/* Tree interactions                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Handles clicks inside the tree area.
 * @param {MouseEvent} event Click event
 * @returns {void}
 */
function onTreeClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !state) {
        return;
    }

    const crumb = target.closest('.cf-crumb');
    if (crumb) {
        openFolder(crumb.getAttribute('data-folder-id') || null);
        return;
    }

    const row = target.closest('.cf-row');
    if (!row) {
        return;
    }

    const folderId = row.getAttribute('data-folder-id') || null;

    if (target.closest('.cf-twisty') && folderId) {
        const folder = getFolder(state, folderId);
        if (folder && getChildren(state, folderId).length > 0) {
            const collapsing = !folder.collapsed;
            setFolderCollapsed(state, folderId, collapsing);
            if (collapsing) {
                // Closing a folder also leaves the folders nested inside it, so the
                // filtered list never contradicts what the tree shows.
                const openFolderId = state.ui.openFolderId ?? null;
                if (openFolderId && openFolderId !== folderId && getDescendantIds(state, folderId).includes(openFolderId)) {
                    state.ui.openFolderId = folderId;
                    refreshList({ resetPage: true });
                }
            }
            commit({ relist: false, immediate: false });
        }
        return;
    }

    if (target.closest('.cf-row-menu')) {
        openFolderActions(folderId);
        return;
    }

    // While characters are selected, clicking a folder moves them there instead of
    // opening it - exactly the "select, then click a folder" workflow.
    if (selection.size > 0 && state.ui.clickFolderMovesSelection !== false) {
        moveSelection(folderId);
        return;
    }

    openFolder(folderId);
}

/**
 * Handles double clicks inside the tree (rename).
 * @param {MouseEvent} event Double click event
 * @returns {void}
 */
function onTreeDoubleClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    const row = target.closest('.cf-row');
    const folderId = row?.getAttribute('data-folder-id');
    if (folderId) {
        onRenameFolder(folderId);
    }
}

/**
 * Handles right clicks inside the tree.
 * @param {MouseEvent} event Context menu event
 * @returns {void}
 */
function onTreeContextMenu(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    const row = target.closest('.cf-row');
    if (!row) {
        return;
    }
    event.preventDefault();
    openFolderActions(row.getAttribute('data-folder-id') || null);
}

/**
 * Updates the "open" highlighting and the breadcrumb without rebuilding the tree,
 * so that clicking a row does not invalidate the element the user is interacting
 * with (which would break double-click renaming).
 * @returns {void}
 */
function updateOpenState() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || !state) {
        return;
    }

    const openFolderId = state.ui.openFolderId ?? null;
    for (const row of panel.querySelectorAll('.cf-row')) {
        row.classList.toggle('cf-open', (row.getAttribute('data-folder-id') || null) === openFolderId);
    }

    renderBreadcrumb(panel);
}

/**
 * Opens a folder (or the root when null) and filters the character list.
 * @param {string|null} folderId Folder id, or null for the root
 * @returns {void}
 */
function openFolder(folderId) {
    if (!state) {
        return;
    }

    const target = folderId && getFolder(state, folderId) ? folderId : null;
    if (target === (state.ui.openFolderId ?? null)) {
        return;
    }

    state.ui.openFolderId = target;
    saveState({ immediate: false });
    updateOpenState();
    refreshList({ resetPage: true });
}

/* -------------------------------------------------------------------------- */
/* Folder actions                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Creates a new top-level folder.
 * @returns {Promise<void>} Resolves when done
 */
async function onNewFolder() {
    const context = ctx();
    if (!context || !state) {
        return;
    }

    const name = await context.Popup.show.input(t`New folder`, t`Name of the new folder:`);
    if (!name) {
        return;
    }

    const folder = createFolder(state, { name, parentId: state.ui.openFolderId ?? null });
    if (!folder) {
        toast('warning', t`Please provide a valid folder name.`);
        return;
    }

    commit({ relist: false });
    toast('success', t`Folder "${folder.name}" created.`);
}

/**
 * Creates a subfolder inside the given folder.
 * @param {string} parentId Parent folder id
 * @returns {Promise<void>} Resolves when done
 */
async function onNewSubfolder(parentId) {
    const context = ctx();
    if (!context || !state) {
        return;
    }

    const parent = getFolder(state, parentId);
    if (!parent) {
        return;
    }

    const name = await context.Popup.show.input(t`New subfolder`, t`Name of the new subfolder in "${escapeHtml(parent.name)}":`);
    if (!name) {
        return;
    }

    const folder = createFolder(state, { name, parentId });
    if (!folder) {
        toast('warning', t`Please provide a valid folder name.`);
        return;
    }

    setFolderCollapsed(state, parentId, false);
    commit({ relist: false });
    toast('success', t`Folder "${folder.name}" created.`);
}

/**
 * Starts inline renaming of a folder.
 * @param {string} folderId Folder id
 * @returns {void}
 */
function onRenameFolder(folderId) {
    if (!state || renamingFolderId) {
        return;
    }

    const folder = getFolder(state, folderId);
    const panel = document.getElementById(PANEL_ID);
    const row = panel?.querySelector(`.cf-row[data-folder-id="${CSS.escape(folderId)}"]`);
    const nameElement = row?.querySelector('.cf-name');
    if (!folder || !row || !nameElement) {
        return;
    }

    renamingFolderId = folderId;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cf-name-input text_pole';
    input.value = folder.name;
    input.maxLength = MAX_NAME_LENGTH;
    nameElement.replaceWith(input);
    input.focus();
    input.select();

    let finished = false;
    const finish = (apply) => {
        if (finished) {
            return;
        }
        finished = true;
        renamingFolderId = null;
        if (apply) {
            const renamed = renameFolder(state, folderId, input.value);
            if (renamed && renamed.name !== folder.name) {
                commit({ relist: false });
                return;
            }
        }
        renderPanel();
    };

    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            finish(true);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            finish(false);
        }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('dblclick', event => event.stopPropagation());
}

/**
 * Changes a folder color.
 * @param {string} folderId Folder id
 * @returns {Promise<void>} Resolves when done
 */
async function onColorFolder(folderId) {
    const context = ctx();
    const folder = state ? getFolder(state, folderId) : null;
    if (!context || !folder) {
        return;
    }

    const current = normalizeColor(folder.color) || '#808080';
    const content = $(`
        <div class="cf-color-popup">
            <label for="cf_color_input">${t`Folder color`}</label>
            <input id="cf_color_input" type="color" value="${current}">
            <div class="cf-color-actions">
                <button type="button" class="menu_button cf-color-reset">${t`Reset`}</button>
            </div>
        </div>
    `);

    let picked = folder.color;
    content.find('#cf_color_input').on('input', function () {
        picked = String($(this).val());
    });
    content.find('.cf-color-reset').on('click', function () {
        picked = '';
        content.find('#cf_color_input').val('#808080');
    });

    const result = await new context.Popup(content, context.POPUP_TYPE.TEXT, '', {
        okButton: t`Apply`,
        cancelButton: t`Cancel`,
    }).show();

    // Only apply on "Apply", so canceling never changes the color.
    if (result === context.POPUP_RESULT.AFFIRMATIVE) {
        setFolderColor(state, folderId, picked);
        commit({ relist: false });
    }
}

/**
 * Moves a folder one position up or down among its siblings.
 * @param {string} folderId Folder id
 * @param {number} delta Direction (-1 = up, 1 = down)
 * @returns {void}
 */
function onReorderFolder(folderId, delta) {
    if (!state) {
        return;
    }

    const folder = getFolder(state, folderId);
    if (!folder) {
        return;
    }

    const siblings = getChildren(state, folder.parentId);
    const index = siblings.findIndex(sibling => sibling.id === folderId);
    const targetIndex = index + delta;
    if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) {
        return;
    }

    moveFolder(state, folderId, folder.parentId, targetIndex);
    commit({ relist: false });
}

/**
 * Deletes a folder after confirmation.
 * @param {string} folderId Folder id
 * @returns {Promise<void>} Resolves when done
 */
async function onDeleteFolder(folderId) {
    const context = ctx();
    const folder = state ? getFolder(state, folderId) : null;
    if (!context || !folder) {
        return;
    }

    const confirm = await context.Popup.show.confirm(
        t`Delete folder "${escapeHtml(folder.name)}"?`,
        t`Characters and subfolders are kept: they are moved one level up. Nothing is deleted from disk.`,
    );
    if (!confirm) {
        return;
    }

    const summary = deleteFolder(state, folderId);
    if (!summary) {
        return;
    }

    commit({ resetPage: false });
    toast('success', t`Folder deleted. ${summary.folders} subfolder(s) and ${summary.characters} character(s) were moved up.`);
}

/**
 * Opens the action popup of a folder row.
 * @param {string|null} folderId Folder id, or null for the unfiled row
 * @returns {Promise<void>} Resolves when the popup is closed
 */
async function openFolderActions(folderId) {
    const context = ctx();
    if (!context || !state) {
        return;
    }

    if (!folderId) {
        await onOpenOptions();
        return;
    }

    const folder = getFolder(state, folderId);
    if (!folder) {
        return;
    }

    const siblings = getChildren(state, folder.parentId);
    const index = siblings.findIndex(sibling => sibling.id === folderId);
    const count = getCharacterCount(state, folderId);

    /** @type {{text: string, icon?: string, result?: number}[]} */
    const buttons = [
        { text: t`New subfolder`, icon: 'fa-folder-plus', result: FOLDER_ACTION.NEW_SUBFOLDER },
        { text: t`Rename`, icon: 'fa-pen', result: FOLDER_ACTION.RENAME },
        { text: t`Color`, icon: 'fa-palette', result: FOLDER_ACTION.COLOR },
    ];

    if (index > 0) {
        buttons.push({ text: t`Move up`, icon: 'fa-arrow-up', result: FOLDER_ACTION.MOVE_UP });
    }
    if (index >= 0 && index < siblings.length - 1) {
        buttons.push({ text: t`Move down`, icon: 'fa-arrow-down', result: FOLDER_ACTION.MOVE_DOWN });
    }
    if (folder.parentId) {
        buttons.push({ text: t`Move to root`, icon: 'fa-turn-up', result: FOLDER_ACTION.MOVE_TO_ROOT });
    }
    buttons.push({ text: t`Delete`, icon: 'fa-trash', result: FOLDER_ACTION.DELETE, classes: ['cf-danger'] });

    const header = `${escapeHtml(folder.name)} — ${t`${count} character(s) directly in this folder`}`;
    const result = await new context.Popup(header, context.POPUP_TYPE.TEXT, '', {
        customButtons: buttons,
        okButton: false,
        cancelButton: t`Cancel`,
        wide: false,
    }).show();

    switch (result) {
        case FOLDER_ACTION.NEW_SUBFOLDER:
            await onNewSubfolder(folderId);
            break;
        case FOLDER_ACTION.RENAME:
            onRenameFolder(folderId);
            break;
        case FOLDER_ACTION.COLOR:
            await onColorFolder(folderId);
            break;
        case FOLDER_ACTION.MOVE_UP:
            onReorderFolder(folderId, -1);
            break;
        case FOLDER_ACTION.MOVE_DOWN:
            onReorderFolder(folderId, 1);
            break;
        case FOLDER_ACTION.MOVE_TO_ROOT:
            moveFolder(state, folderId, null);
            commit({ relist: false });
            break;
        case FOLDER_ACTION.DELETE:
            await onDeleteFolder(folderId);
            break;
        default:
            break;
    }
}

/* -------------------------------------------------------------------------- */
/* Selection and bulk moving                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Ordered avatars of the character cards currently rendered in the list.
 * @returns {string[]} Avatar file names in display order
 */
function renderedAvatars() {
    const list = document.getElementById('rm_print_characters_block');
    if (!list) {
        return [];
    }

    const context = ctx();
    const avatars = [];
    for (const card of list.querySelectorAll('.character_select[data-chid]')) {
        const chid = Number(card.getAttribute('data-chid'));
        const avatar = context?.characters?.[chid]?.avatar ?? card.getAttribute('data-cf-avatar');
        if (typeof avatar === 'string' && avatar.length > 0) {
            avatars.push(avatar);
        }
    }
    return avatars;
}

/**
 * Applies the current selection to the rendered cards.
 * @returns {void}
 */
function updateCardSelectionUI() {
    const list = document.getElementById('rm_print_characters_block');
    if (!list) {
        return;
    }

    for (const card of list.querySelectorAll('.character_select')) {
        const avatar = card.getAttribute('data-cf-avatar');
        const isSelected = Boolean(avatar) && selection.has(avatar);
        card.classList.toggle('cf-selected', isSelected);
        const control = card.querySelector('.cf-card-select');
        if (control) {
            control.classList.toggle('cf-on', isSelected);
            control.setAttribute('aria-checked', String(isSelected));
        }
    }
}

/**
 * Toggles one character in the selection.
 * @param {string} avatar Avatar file name
 * @returns {void}
 */
function toggleSelection(avatar) {
    if (selection.has(avatar)) {
        selection.delete(avatar);
    } else {
        selection.add(avatar);
    }
    lastSelectedAvatar = avatar;
    renderSelectionState();
    updateCardSelectionUI();
}

/**
 * Extends the selection from the anchor to the given avatar over the rendered order.
 * @param {string} avatar Avatar file name
 * @returns {void}
 */
function selectRange(avatar) {
    const order = renderedAvatars();
    const from = order.indexOf(lastSelectedAvatar ?? avatar);
    const to = order.indexOf(avatar);
    if (from === -1 || to === -1) {
        toggleSelection(avatar);
        return;
    }

    const [start, end] = from <= to ? [from, to] : [to, from];
    for (const candidate of order.slice(start, end + 1)) {
        selection.add(candidate);
    }
    lastSelectedAvatar = avatar;
    renderSelectionState();
    updateCardSelectionUI();
}

/**
 * Selects every character that is currently shown in the list.
 * @returns {void}
 */
function selectAllShown() {
    for (const avatar of renderedAvatars()) {
        selection.add(avatar);
    }
    lastSelectedAvatar = null;
    renderSelectionState();
    updateCardSelectionUI();
}

/**
 * Clears the selection.
 * @returns {void}
 */
function clearSelection() {
    selection.clear();
    lastSelectedAvatar = null;
    renderSelectionState();
    updateCardSelectionUI();
}

/**
 * Handles clicks on the selection bar.
 * @param {MouseEvent} event Click event
 * @returns {void}
 */
function onSelectionBarClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    if (target.closest('.cf-sel-clear')) {
        if (selection.size === 0) {
            // Dismiss the undo offer.
            lastBulkMove = null;
            renderPanel();
        } else {
            clearSelection();
        }
    } else if (target.closest('.cf-sel-all')) {
        selectAllShown();
    } else if (target.closest('.cf-sel-unfile')) {
        moveSelection(null);
    } else if (target.closest('.cf-sel-undo')) {
        undoLastMove();
    } else if (target.closest('.cf-sel-move')) {
        onMoveSelectionDialog();
    }
}

/**
 * Moves every selected character into a folder (null = no folder).
 * @param {string|null} folderId Target folder id
 * @returns {void}
 */
function moveSelection(folderId) {
    if (!state || selection.size === 0) {
        return;
    }

    const target = folderId && getFolder(state, folderId) ? folderId : null;
    const entries = [];
    for (const avatar of selection) {
        const previous = getCharacterFolderId(state, avatar) ?? null;
        if (previous !== target && assignCharacter(state, avatar, target)) {
            entries.push({ avatar, previous });
        }
    }

    if (entries.length === 0) {
        toast('info', t`Those characters are already in that folder.`);
        clearSelection();
        return;
    }

    lastBulkMove = { targetFolderId: target, entries };
    selection.clear();
    saveState();
    renderPanel();
    refreshList({ resetPage: false });

    const targetName = target ? getFolder(state, target)?.name : t`Unfiled`;
    toast('success', t`${entries.length} character(s) moved to "${targetName}".`);
}

/**
 * Reverts the last bulk move.
 * @returns {void}
 */
function undoLastMove() {
    if (!state || !lastBulkMove) {
        return;
    }

    let moved = 0;
    for (const entry of lastBulkMove.entries) {
        if (assignCharacter(state, entry.avatar, entry.previous)) {
            moved++;
        }
    }

    lastBulkMove = null;
    saveState();
    renderPanel();
    refreshList({ resetPage: false });
    if (moved > 0) {
        toast('success', t`${moved} character(s) moved back.`);
    } else {
        toast('info', t`Nothing to undo any more.`);
    }
}

/**
 * Lets the user pick a folder from a list and moves the selection there.
 * @returns {Promise<void>} Resolves when done
 */
async function onMoveSelectionDialog() {
    const folderId = await chooseFolder(t`Move to folder`);
    if (folderId === undefined) {
        return;
    }
    moveSelection(folderId);
}

/**
 * Shows a scrollable folder picker.
 * @param {string} header Popup header
 * @returns {Promise<string|null|undefined>} Folder id, null for "Unfiled", undefined when cancelled
 */
async function chooseFolder(header) {
    const context = ctx();
    if (!context || !state) {
        return undefined;
    }

    const rows = collectVisibleFolders(null, 0, []);
    const options = [
        `<label class="cf-pick-row" style="--cf-depth:0"><input type="radio" name="cf_pick" value="" checked> <i class="cf-folder-icon fa-solid fa-inbox"></i> ${t`Unfiled`}</label>`,
        ...rows.map(({ folder, depth }) => `
            <label class="cf-pick-row" style="--cf-depth:${depth + 1}">
                <input type="radio" name="cf_pick" value="${escapeHtml(folder.id)}">
                <i class="cf-folder-icon fa-solid fa-folder"></i> ${escapeHtml(folder.name)}
                <span class="cf-count">${getCharacterCount(state, folder.id)}</span>
            </label>
        `),
    ];

    const content = $(`<div class="cf-pick-popup"><div class="cf-pick-list">${options.join('')}</div></div>`);
    let picked;
    const result = await new context.Popup(content, context.POPUP_TYPE.TEXT, '', {
        okButton: t`Move here`,
        cancelButton: t`Cancel`,
        onClosing: () => {
            picked = content.find('input[name="cf_pick"]:checked').val() ?? '';
            return true;
        },
    }).show();

    if (result !== context.POPUP_RESULT.AFFIRMATIVE) {
        return undefined;
    }

    return picked ? String(picked) : null;
}

/* -------------------------------------------------------------------------- */
/* Drag & drop                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Adds the selection checkbox to every visible character card. The checkbox is both
 * the selection control (click, shift-click for a range) and the drag handle (drag
 * onto a folder). Cards are re-created by the core pagination, so this runs again
 * after every page render.
 * @returns {void}
 */
function attachCardControls() {
    const list = document.getElementById('rm_print_characters_block');
    if (!list || typeof $ === 'undefined' || typeof $.fn?.draggable !== 'function') {
        return;
    }

    // In bulk edit mode the cards are multi-select targets; our control would fight it.
    if (list.classList.contains('bulk_select')) {
        return;
    }

    const mobile = ctx()?.isMobile?.() === true;
    const context = ctx();

    for (const card of list.querySelectorAll('.character_select')) {
        const chid = Number(card.getAttribute('data-chid'));
        const character = Number.isInteger(chid) ? context?.characters?.[chid] : null;
        const avatar = character?.avatar;
        if (typeof avatar !== 'string' || avatar.length === 0) {
            continue;
        }

        // The payload lives in attributes so that the cloned drag helper carries it too.
        const $card = $(card);
        $card.attr({ 'data-cf-kind': 'character', 'data-cf-avatar': avatar });

        if (!card.querySelector('.cf-card-select')) {
            const control = document.createElement('span');
            control.className = 'cf-card-select';
            control.setAttribute('role', 'checkbox');
            control.setAttribute('aria-checked', 'false');
            control.title = t`Click to select · drag onto a folder to move`;
            control.innerHTML = '<i class="fa-solid fa-check"></i>';
            // Do not let the control trigger the card's own click handler.
            control.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if (event.shiftKey && lastSelectedAvatar) {
                    selectRange(avatar);
                } else {
                    toggleSelection(avatar);
                }
            });
            control.addEventListener('dblclick', event => event.stopPropagation());
            card.appendChild(control);
        }

        if (!$card.data('cf-draggable')) {
            $card.data('cf-draggable', true);
            $card.draggable({
                handle: '.cf-card-select',
                helper: function () {
                    const dragged = $(this);
                    const count = selection.has(dragged.attr('data-cf-avatar')) ? Math.max(1, selection.size) : 1;
                    const helper = dragged
                        .clone()
                        .addClass('cf-drag-item cf-drag-helper')
                        .attr('data-cf-character', '1')
                        .css({ width: dragged.outerWidth(), opacity: 0.85 });
                    if (count > 1) {
                        helper.append(`<span class="cf-drag-count">${count}</span>`);
                    }
                    return helper;
                },
                appendTo: 'body',
                zIndex: 100001,
                revert: 'invalid',
                revertDuration: 120,
                // Keep autoscroll on: with many characters the folder panel is scrolled
                // out of view, and dragging towards the edge has to scroll the list.
                scroll: true,
                scrollSensitivity: 40,
                scrollSpeed: 20,
                distance: mobile ? 12 : 6,
                delay: mobile ? 200 : 0,
                start: function () {
                    $(this).addClass('cf-dragging');
                },
                stop: function () {
                    $(this).removeClass('cf-dragging');
                },
            });
        }
    }

    updateCardSelectionUI();
}

/**
 * Handles a drop onto a folder row.
 * @param {Element} row Target row
 * @param {{kind: string, folderId?: string, avatar?: string}|null} dragData Dragged payload
 * @returns {void}
 */
function onDropOnFolder(row, dragData) {
    if (!state || !dragData) {
        return;
    }

    const targetFolderId = row.getAttribute('data-folder-id') || null;

    if (dragData.kind === 'character' && dragData.avatar) {
        // Dragging one of several selected characters moves the whole selection.
        if (selection.has(dragData.avatar) && selection.size > 1) {
            moveSelection(targetFolderId);
            return;
        }

        const previous = getCharacterFolderId(state, dragData.avatar) ?? null;
        if (assignCharacter(state, dragData.avatar, targetFolderId)) {
            lastBulkMove = { targetFolderId, entries: [{ avatar: dragData.avatar, previous }] };
            saveState();
            renderPanel();
            refreshList({ resetPage: false });
            const targetName = targetFolderId ? getFolder(state, targetFolderId)?.name : t`Unfiled`;
            toast('success', t`Character moved to "${targetName}".`);
        }
        return;
    }

    if (dragData.kind === 'folder' && typeof dragData.folderId === 'string') {
        if (dragData.folderId === targetFolderId) {
            return;
        }
        if (moveFolder(state, dragData.folderId, targetFolderId)) {
            const moved = getFolder(state, dragData.folderId);
            commit({ relist: false });
            const targetName = targetFolderId ? getFolder(state, targetFolderId)?.name : t`the root level`;
            toast('success', t`Folder "${moved?.name}" moved into "${targetName}".`);
        } else {
            toast('warning', t`A folder cannot be moved into itself or one of its subfolders.`);
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Options, backup and migration                                              */
/* -------------------------------------------------------------------------- */

/**
 * Opens the options popup with toggles, backup and migration tools.
 * @returns {Promise<void>} Resolves when the popup is closed
 */
async function onOpenOptions() {
    const context = ctx();
    if (!context || !state) {
        return;
    }

    const staleCount = countStaleAssignments();

    const content = $(`
        <div class="cf-options-popup">
            <label class="checkbox_label" for="cf_opt_subfolders">
                <input id="cf_opt_subfolders" type="checkbox" ${state.ui.includeSubfolders !== false ? 'checked' : ''}>
                <span>${t`Include subfolders when a folder is opened`}</span>
            </label>
            <label class="checkbox_label" for="cf_opt_all_in_root">
                <input id="cf_opt_all_in_root" type="checkbox" ${state.ui.showAllInRoot ? 'checked' : ''}>
                <span>${t`Show all characters at the root level`}</span>
            </label>
            <label class="checkbox_label" for="cf_opt_hide_tags">
                <input id="cf_opt_hide_tags" type="checkbox" ${state.ui.hideTagFolders ? 'checked' : ''}>
                <span>${t`Hide "Tags as Folders" tiles from the character list`}</span>
            </label>
            <label class="checkbox_label" for="cf_opt_click_moves" title="${t`While characters are selected, clicking a folder moves them there instead of opening it.`}">
                <input id="cf_opt_click_moves" type="checkbox" ${state.ui.clickFolderMovesSelection !== false ? 'checked' : ''}>
                <span>${t`Clicking a folder moves the current selection`}</span>
            </label>
            <small class="cf-hint">${t`Select characters with the checkbox on their card (Shift-click for a range), then click the target folder.`}</small>
            <hr>
            <div class="cf-option-actions">
                <button type="button" class="menu_button cf-act-export"><i class="fa-solid fa-file-export"></i> ${t`Export structure`}</button>
                <button type="button" class="menu_button cf-act-import"><i class="fa-solid fa-file-import"></i> ${t`Import structure`}</button>
                <button type="button" class="menu_button cf-act-from-tags"><i class="fa-solid fa-tags"></i> ${t`Create folders from tags`}</button>
                <button type="button" class="menu_button cf-act-prune"><i class="fa-solid fa-broom"></i> ${staleCount > 0 ? t`Clean up assignments (${staleCount})` : t`Clean up assignments`}</button>
                <button type="button" class="menu_button cf-danger cf-act-reset"><i class="fa-solid fa-trash"></i> ${t`Remove all folders`}</button>
            </div>
            <small class="cf-hint">${t`Folders are stored in your settings file and are included in settings backups.`}</small>
        </div>
    `);

    content.find('#cf_opt_subfolders').on('change', function () {
        state.ui.includeSubfolders = $(this).prop('checked');
        commit({ immediate: false });
    });
    content.find('#cf_opt_all_in_root').on('change', function () {
        state.ui.showAllInRoot = $(this).prop('checked');
        commit({ immediate: false });
    });
    content.find('#cf_opt_hide_tags').on('change', function () {
        state.ui.hideTagFolders = $(this).prop('checked');
        commit({ immediate: false });
    });
    content.find('#cf_opt_click_moves').on('change', function () {
        state.ui.clickFolderMovesSelection = $(this).prop('checked');
        commit({ relist: false, immediate: false });
    });
    content.find('.cf-act-export').on('click', () => exportStructure());
    content.find('.cf-act-import').on('click', () => importStructure());
    content.find('.cf-act-from-tags').on('click', () => createFoldersFromTags());
    content.find('.cf-act-prune').on('click', () => cleanUpAssignments());
    content.find('.cf-act-reset').on('click', () => resetEverything());

    await new context.Popup(content, context.POPUP_TYPE.TEXT, '', {
        okButton: t`Close`,
        cancelButton: false,
        wide: false,
    }).show();
}

/**
 * Downloads the folder structure as a JSON backup.
 * @returns {void}
 */
function exportStructure() {
    if (!state) {
        return;
    }

    const blob = new Blob([serializeState(state)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `character-folders-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('success', t`Folder structure exported.`);
}

/**
 * Imports a folder structure from a JSON backup, replacing the current one.
 * @returns {void}
 */
function importStructure() {
    const context = ctx();
    if (!context || !state) {
        return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) {
            return;
        }

        try {
            const imported = parseState(await file.text());
            const confirm = await context.Popup.show.confirm(
                t`Replace the current folder structure?`,
                t`The backup contains ${imported.folders.length} folder(s) and ${Object.keys(imported.assignments).length} assignment(s). Your current structure will be overwritten.`,
            );
            if (!confirm) {
                return;
            }

            state = imported;
            state.ui.panelCollapsed = false;
            // The previous structure is gone, so a pending selection or undo would
            // point into it: clear both before rendering.
            selection.clear();
            lastBulkMove = null;
            lastSelectedAvatar = null;
            commit({ resetPage: true });
            toast('success', t`Folder structure imported.`);
        } catch (error) {
            console.error(LOG, 'Import failed', error);
            toast('error', `${t`Could not import the backup:`} ${error.message}`);
        }
    });
    input.click();
}

/**
 * Creates one folder per existing SillyTavern tag and files tagged characters
 * into them. Characters that already have a folder keep it.
 * @returns {void}
 */
function createFoldersFromTags() {
    const context = ctx();
    if (!context || !state) {
        return;
    }

    const tags = Array.isArray(context.tags) ? context.tags : [];
    const tagMap = context.tagMap && typeof context.tagMap === 'object' ? context.tagMap : {};
    // Only real character avatars take part; tag_map also contains group ids.
    const avatarSet = new Set(knownAvatars());
    const characterEntries = Object.entries(tagMap).filter(([avatar]) => avatarSet.has(avatar));
    const folderByTagId = new Map();
    let createdFolders = 0;
    let assigned = 0;

    for (const tag of tags) {
        const used = characterEntries.some(([avatar, tagIds]) => Array.isArray(tagIds) && tagIds.includes(tag.id) && getCharacterFolderId(state, avatar) === null);
        if (!used) {
            continue;
        }
        const existing = state.folders.find(folder => folder.name.toLowerCase() === String(tag.name).toLowerCase());
        const folder = existing ?? createFolder(state, { name: String(tag.name ?? ''), color: typeof tag.color === 'string' ? tag.color : '' });
        if (folder) {
            folderByTagId.set(tag.id, folder.id);
            if (!existing) {
                createdFolders++;
            }
        }
    }

    for (const [avatar, tagIds] of characterEntries) {
        if (!Array.isArray(tagIds) || getCharacterFolderId(state, avatar) !== null) {
            continue;
        }
        const tagId = tagIds.find(id => folderByTagId.has(id));
        if (tagId && assignCharacter(state, avatar, folderByTagId.get(tagId))) {
            assigned++;
        }
    }

    commit({ resetPage: true });
    toast('success', t`Created ${createdFolders} folder(s) from tags and filed ${assigned} character(s). Characters that were already filed were left untouched.`);
}

/**
 * Removes assignments of characters that no longer exist. This is the only place
 * that prunes, and it refuses to run while the character list is still empty.
 * @returns {void}
 */
function cleanUpAssignments() {
    if (!state) {
        return;
    }

    const avatars = knownAvatars();
    if (avatars.length === 0) {
        toast('warning', t`The character list is not loaded yet, so nothing can be checked. Please try again in a moment.`);
        return;
    }

    const removed = pruneAssignments(state, avatars);
    commit({ relist: false });
    if (removed > 0) {
        toast('success', t`Removed ${removed} assignment(s) of characters that no longer exist.`);
    } else {
        toast('info', t`Nothing to clean up.`);
    }
}

/**
 * Deletes all folders and assignments (characters themselves are untouched).
 * @returns {Promise<void>} Resolves when done
 */
async function resetEverything() {
    const context = ctx();
    if (!context || !state) {
        return;
    }

    const confirm = await context.Popup.show.confirm(
        t`Remove all folders?`,
        t`All folders and assignments are deleted. Your character cards, chats and tags are not touched.`,
    );
    if (!confirm) {
        return;
    }

    state = createEmptyState();
    selection.clear();
    lastBulkMove = null;
    lastSelectedAvatar = null;
    commit({ resetPage: true });
    toast('success', t`All folders removed.`);
}

/* -------------------------------------------------------------------------- */
/* Initialization                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Extension entry point, called by the manifest "activate" hook.
 * @returns {Promise<void>} Resolves when the extension is ready
 */
export async function init() {
    const context = ctx();
    if (!context) {
        console.warn(LOG, 'SillyTavern context is not available, the extension will not start.');
        return;
    }

    loadState(context);
    registerFilter();

    eventSourceOn(context, context.eventTypes.SETTINGS_LOADED_AFTER, () => {
        loadState(context);
        registerFilter();
        renderPanel();
        refreshList();
    });

    // The character list is re-rendered for many reasons (search, paging, sorting).
    // The folder tree does not depend on those, so only the cards and the "Unfiled"
    // counter are refreshed - a full panel rebuild would run on every keystroke.
    // The one case that does need a rebuild is the list arriving or changing size,
    // because the folder counters are derived from it.
    eventSourceOn(context, context.eventTypes.CHARACTER_PAGE_LOADED, () => {
        attachCardControls();
        if (knownAvatars().length !== lastRenderedAvatarCount) {
            renderPanel();
            return;
        }
        updateUnfiledCount();
    });

    eventSourceOn(context, context.eventTypes.CHARACTER_RENAMED, (oldAvatar, newAvatar) => {
        if (selection.delete(oldAvatar)) {
            selection.add(newAvatar);
        }
        if (lastSelectedAvatar === oldAvatar) {
            lastSelectedAvatar = newAvatar;
        }
        if (renameCharacterAvatar(state, oldAvatar, newAvatar)) {
            saveState();
            renderPanel();
        }
    });

    eventSourceOn(context, context.eventTypes.CHARACTER_DUPLICATED, data => {
        // A duplicate is a *copy*: the original keeps its folder, the copy inherits it.
        if (data?.oldAvatar && data?.newAvatar) {
            if (copyCharacterAssignment(state, data.oldAvatar, data.newAvatar)) {
                saveState();
                renderPanel();
            }
        }
    });

    eventSourceOn(context, context.eventTypes.CHARACTER_DELETED, data => {
        const avatar = data?.character?.avatar;
        if (avatar) {
            selection.delete(avatar);
            if (lastSelectedAvatar === avatar) {
                lastSelectedAvatar = null;
            }
        }
        if (avatar && state.assignments[avatar]) {
            delete state.assignments[avatar];
            saveState();
            renderPanel();
        }
    });

    renderPanel();
    attachCardControls();
    console.log(LOG, 'ready —', state.folders.length, 'folder(s) loaded.');
}

/**
 * Subscribes to an event, ignoring unknown event names.
 * @param {object} context ST context
 * @param {string|undefined} eventName Event name
 * @param {(...args: any[]) => void} handler Handler
 * @returns {void}
 */
function eventSourceOn(context, eventName, handler) {
    if (!eventName) {
        return;
    }
    context.eventSource?.on?.(eventName, handler);
}
