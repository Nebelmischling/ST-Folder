/**
 * Character Folders — pure state logic.
 *
 * This module contains every rule of the folder system and has **no** dependency on
 * SillyTavern, jQuery or the DOM, so it can be unit tested in plain Node
 * (`node --test folder-store.test.js`).
 *
 * Data model (persisted in `extension_settings['character-folders']`):
 *
 * ```js
 * {
 *     version: 1,
 *     folders: [
 *         { id: 'f_1', name: 'Fantasy', parentId: null, order: 0, color: '#8a2be2', collapsed: false },
 *     ],
 *     // Exactly one folder per character. Missing key = not assigned to any folder.
 *     assignments: { 'Aria.png': 'f_1' },
 *     ui: {
 *         openFolderId: null,      // Folder currently drilled into (null = root)
 *         showAllInRoot: false,    // Root view shows every character instead of only unassigned ones
 *         hideTagFolders: false,   // Hide the built-in "Tags as Folders" tiles while this panel is active
 *     },
 * }
 * ```
 */

/** Version of the persisted state, used for forward-compatible imports. */
export const STORE_VERSION = 1;

/** The id of the virtual root "folder" (i.e. "no parent"). */
export const ROOT_ID = null;

/** Maximum length of a folder name, in characters. */
export const MAX_NAME_LENGTH = 60;

/**
 * Creates a fresh, empty state object.
 * @returns {object} An empty state
 */
export function createEmptyState() {
    return {
        version: STORE_VERSION,
        folders: [],
        assignments: {},
        ui: {
            openFolderId: ROOT_ID,
            includeSubfolders: true,
            showAllInRoot: false,
            hideTagFolders: false,
            panelCollapsed: false,
            clickFolderMovesSelection: true,
        },
    };
}

/**
 * Generates a unique folder id. Uses `crypto.randomUUID` when available and falls
 * back to a timestamp/random combination, because ST is often served over plain
 * HTTP on a LAN address where `crypto.randomUUID` does not exist.
 * @returns {string} A new folder id
 */
export function generateId() {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (typeof uuid === 'string' && uuid.length > 0) {
        return `f_${uuid}`;
    }
    return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Cleans up a user-provided folder name.
 * @param {unknown} name Raw name
 * @returns {string} Trimmed name without control characters, limited to `MAX_NAME_LENGTH`
 */
export function sanitizeFolderName(name) {
    if (typeof name !== 'string') {
        return '';
    }
    // eslint-disable-next-line no-control-regex
    return name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
}

/**
 * @typedef {object} Folder
 * @property {string} id Unique folder id
 * @property {string} name Display name (unique among siblings)
 * @property {string|null} parentId Parent folder id, or null for a top-level folder
 * @property {number} order Sort position among siblings
 * @property {string} color Optional accent color (empty string = default)
 * @property {boolean} collapsed Whether the subtree is collapsed in the tree panel
 */

/**
 * Coerces raw (possibly user-edited or corrupted) data into a valid state.
 * Never throws: invalid folders, dangling parents, cycles and assignments to
 * non-existing folders are dropped silently.
 * @param {unknown} raw Raw state, e.g. loaded from settings
 * @returns {object} A valid state
 */
export function normalizeState(raw) {
    const state = createEmptyState();

    if (!raw || typeof raw !== 'object') {
        return state;
    }

    const rawFolders = Array.isArray(raw.folders) ? raw.folders : [];
    const seenIds = new Set();

    for (const rawFolder of rawFolders) {
        if (!rawFolder || typeof rawFolder !== 'object') {
            continue;
        }

        const id = typeof rawFolder.id === 'string' && rawFolder.id.length > 0 ? rawFolder.id : generateId();
        if (seenIds.has(id)) {
            continue;
        }
        // Block prototype-pollution style ids coming from an imported file.
        if (id === '__proto__' || id === 'constructor' || id === 'prototype') {
            continue;
        }

        const name = sanitizeFolderName(rawFolder.name) || 'Folder';
        seenIds.add(id);
        state.folders.push({
            id,
            name,
            parentId: typeof rawFolder.parentId === 'string' && rawFolder.parentId.length > 0 ? rawFolder.parentId : ROOT_ID,
            order: Number.isFinite(rawFolder.order) ? Number(rawFolder.order) : state.folders.length,
            color: typeof rawFolder.color === 'string' ? rawFolder.color.slice(0, 32) : '',
            collapsed: rawFolder.collapsed === true,
        });
    }

    repairStructure(state);

    const rawAssignments = raw.assignments && typeof raw.assignments === 'object' ? raw.assignments : {};
    for (const [avatar, folderId] of Object.entries(rawAssignments)) {
        if (typeof avatar !== 'string' || avatar.length === 0) {
            continue;
        }
        if (typeof folderId !== 'string' || !seenIds.has(folderId)) {
            continue;
        }
        state.assignments[avatar] = folderId;
    }

    const rawUi = raw.ui && typeof raw.ui === 'object' ? raw.ui : {};
    const openFolderId = typeof rawUi.openFolderId === 'string' ? rawUi.openFolderId : ROOT_ID;
    state.ui = {
        openFolderId: seenIds.has(openFolderId) ? openFolderId : ROOT_ID,
        includeSubfolders: rawUi.includeSubfolders !== false,
        showAllInRoot: rawUi.showAllInRoot === true,
        hideTagFolders: rawUi.hideTagFolders === true,
        panelCollapsed: rawUi.panelCollapsed === true,
        clickFolderMovesSelection: rawUi.clickFolderMovesSelection !== false,
    };

    sortAllSiblings(state);
    return state;
}

/**
 * Resets missing parents to root, repairs self-references and cycles, and removes
 * duplicate sibling names.
 * @param {object} state State to repair in place
 * @returns {void}
 */
function repairStructure(state) {
    const byId = new Map(state.folders.map(folder => [folder.id, folder]));

    for (const folder of state.folders) {
        if (folder.parentId === folder.id || !byId.has(folder.parentId)) {
            folder.parentId = ROOT_ID;
        }
    }

    for (const folder of state.folders) {
        const visited = new Set([folder.id]);
        let current = byId.get(folder.parentId);
        while (current) {
            if (visited.has(current.id)) {
                // Cycle detected: detach the folder that closes it.
                folder.parentId = ROOT_ID;
                break;
            }
            visited.add(current.id);
            current = byId.get(current.parentId);
        }
    }

    // Make sibling names unique so the tree stays readable. Siblings are walked in
    // display order, so the folder shown first keeps its name and later duplicates
    // get a numeric suffix.
    for (const parentId of [ROOT_ID, ...state.folders.map(folder => folder.id)]) {
        const takenNames = [];
        for (const child of siblingsOf(state, parentId)) {
            child.name = makeNameUnique(child.name, takenNames);
            takenNames.push(child.name);
        }
    }
}

/**
 * Appends a numeric suffix until the name is unique within the given list.
 * @param {string} name Desired name
 * @param {string[]} takenNames Names that are already in use
 * @returns {string} A unique name
 */
function makeNameUnique(name, takenNames) {
    const lowered = new Set(takenNames.map(taken => taken.toLowerCase()));
    if (!lowered.has(name.toLowerCase())) {
        return name;
    }

    for (let index = 2; index < 10000; index++) {
        const candidate = `${name} (${index})`;
        if (!lowered.has(candidate.toLowerCase())) {
            return candidate;
        }
    }

    return `${name} (${Date.now()})`;
}

/**
 * Re-numbers the children of every folder (and of the root) so that `order`
 * values are dense and reflect the current visual order.
 * @param {object} state State to update in place
 * @returns {void}
 */
function sortAllSiblings(state) {
    const parents = [ROOT_ID, ...state.folders.map(folder => folder.id)];
    for (const parentId of parents) {
        const children = siblingsOf(state, parentId);
        children.forEach((folder, index) => {
            folder.order = index;
        });
    }
}

/**
 * Returns the siblings of a folder, sorted by order and name.
 * @param {object} state State
 * @param {string|null} parentId Parent id, or null for top-level folders
 * @returns {Folder[]} Sorted sibling folders
 */
function siblingsOf(state, parentId) {
    return state.folders
        .filter(folder => folder.parentId === parentId)
        .sort(compareFolders);
}

/**
 * Comparator used for all folder listings: manual order first, then name.
 * @param {Folder} a First folder
 * @param {Folder} b Second folder
 * @returns {number} Comparison result
 */
export function compareFolders(a, b) {
    if (a.order !== b.order) {
        return a.order - b.order;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/**
 * Looks up a folder.
 * @param {object} state State
 * @param {string|null} folderId Folder id
 * @returns {Folder|undefined} The folder, if it exists
 */
export function getFolder(state, folderId) {
    if (typeof folderId !== 'string' || folderId.length === 0) {
        return undefined;
    }
    return state.folders.find(folder => folder.id === folderId);
}

/**
 * Returns the direct children of a folder (or of the root).
 * @param {object} state State
 * @param {string|null} parentId Parent id, or null for top-level folders
 * @returns {Folder[]} Sorted child folders
 */
export function getChildren(state, parentId) {
    return siblingsOf(state, parentId ?? ROOT_ID);
}

/**
 * Returns the full path from the root down to the folder (inclusive).
 * @param {object} state State
 * @param {string|null} folderId Folder id
 * @returns {Folder[]} Path of folders; empty for the root or unknown ids
 */
export function getFolderPath(state, folderId) {
    const path = [];
    const visited = new Set();
    let current = getFolder(state, folderId);

    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        path.unshift(current);
        current = getFolder(state, current.parentId);
    }

    return path;
}

/**
 * Returns the ids of all folders below the given one.
 * @param {object} state State
 * @param {string|null} folderId Folder id
 * @returns {string[]} Descendant folder ids (excluding the folder itself)
 */
export function getDescendantIds(state, folderId) {
    const result = [];
    const queue = getChildren(state, folderId).map(folder => folder.id);
    const visited = new Set();

    while (queue.length > 0) {
        const id = queue.shift();
        if (visited.has(id)) {
            continue;
        }
        visited.add(id);
        result.push(id);
        queue.push(...getChildren(state, id).map(folder => folder.id));
    }

    return result;
}

/**
 * Creates a new folder.
 * @param {object} state State to modify in place
 * @param {object} options Options
 * @param {string} options.name Desired folder name
 * @param {string|null} [options.parentId] Parent folder id, or null for top-level
 * @param {string} [options.color] Optional accent color
 * @returns {Folder|null} The created folder, or null if the name or parent is invalid
 */
export function createFolder(state, { name, parentId = ROOT_ID, color = '' }) {
    const parent = parentId === ROOT_ID ? ROOT_ID : getFolder(state, parentId)?.id ?? null;
    const cleanName = sanitizeFolderName(name);

    if (!cleanName) {
        return null;
    }

    const siblings = siblingsOf(state, parent);
    const folder = {
        id: generateId(),
        name: makeNameUnique(cleanName, siblings.map(sibling => sibling.name)),
        parentId: parent,
        order: siblings.length,
        color: typeof color === 'string' ? color.slice(0, 32) : '',
        collapsed: false,
    };

    state.folders.push(folder);
    return folder;
}

/**
 * Renames a folder.
 * @param {object} state State to modify in place
 * @param {string} folderId Folder id
 * @param {string} name New name
 * @returns {Folder|null} The renamed folder, or null if folder or name is invalid
 */
export function renameFolder(state, folderId, name) {
    const folder = getFolder(state, folderId);
    const cleanName = sanitizeFolderName(name);

    if (!folder || !cleanName) {
        return null;
    }

    const siblings = siblingsOf(state, folder.parentId).filter(sibling => sibling.id !== folder.id);
    folder.name = makeNameUnique(cleanName, siblings.map(sibling => sibling.name));
    return folder;
}

/**
 * Sets the accent color of a folder.
 * @param {object} state State to modify in place
 * @param {string} folderId Folder id
 * @param {string} color Color value (empty string resets to default)
 * @returns {boolean} Whether the folder was updated
 */
export function setFolderColor(state, folderId, color) {
    const folder = getFolder(state, folderId);
    if (!folder) {
        return false;
    }
    folder.color = typeof color === 'string' ? color.slice(0, 32) : '';
    return true;
}

/**
 * Sets the collapsed state of a folder.
 * @param {object} state State to modify in place
 * @param {string} folderId Folder id
 * @param {boolean} collapsed Whether the subtree should be collapsed
 * @returns {boolean} Whether the folder was updated
 */
export function setFolderCollapsed(state, folderId, collapsed) {
    const folder = getFolder(state, folderId);
    if (!folder) {
        return false;
    }
    folder.collapsed = collapsed === true;
    return true;
}

/**
 * Deletes a folder without losing data: subfolders move up to the deleted folder's
 * parent, and characters assigned **directly** to it are reassigned to that parent
 * (or unassigned when it was a top-level folder). Characters inside subfolders keep
 * their subfolder, which is simply reparented.
 * @param {object} state State to modify in place
 * @param {string} folderId Folder id
 * @returns {{parentId: string|null, characters: number, folders: number}|null} Summary of what was moved, or null if unknown
 */
export function deleteFolder(state, folderId) {
    const folder = getFolder(state, folderId);
    if (!folder) {
        return null;
    }

    const parentId = folder.parentId ?? ROOT_ID;
    const childFolders = getChildren(state, folderId);
    let movedCharacters = 0;

    for (const child of childFolders) {
        child.parentId = parentId;
    }

    for (const [avatar, assignedId] of Object.entries(state.assignments)) {
        if (assignedId === folderId) {
            if (parentId === ROOT_ID) {
                delete state.assignments[avatar];
            } else {
                state.assignments[avatar] = parentId;
            }
            movedCharacters++;
        }
    }

    state.folders = state.folders.filter(other => other.id !== folderId);

    if (state.ui.openFolderId === folderId) {
        state.ui.openFolderId = parentId;
    }

    sortAllSiblings(state);
    return { parentId, characters: movedCharacters, folders: childFolders.length };
}

/**
 * Moves a folder to a new parent and/or position. Refuses to move a folder into
 * itself or into one of its own descendants.
 * @param {object} state State to modify in place
 * @param {string} folderId Folder to move
 * @param {string|null} newParentId Target parent id, or null for the root
 * @param {number|null} [index] Target index among the new siblings; appended when null/out of range
 * @returns {boolean} Whether the folder was moved
 */
export function moveFolder(state, folderId, newParentId, index = null) {
    const folder = getFolder(state, folderId);
    if (!folder) {
        return false;
    }

    const targetParent = newParentId === ROOT_ID ? ROOT_ID : getFolder(state, newParentId)?.id ?? null;
    if (targetParent === folderId || getDescendantIds(state, folderId).includes(targetParent)) {
        // Would create a cycle.
        return false;
    }

    const siblings = siblingsOf(state, targetParent).filter(sibling => sibling.id !== folderId);
    const insertAt = Number.isInteger(index) ? Math.max(0, Math.min(siblings.length, Number(index))) : siblings.length;

    folder.parentId = targetParent;
    siblings.splice(insertAt, 0, folder);
    siblings.forEach((sibling, position) => {
        sibling.order = position;
    });

    sortAllSiblings(state);
    return true;
}

/**
 * Assigns a character to exactly one folder, replacing any previous assignment.
 * @param {object} state State to modify in place
 * @param {string} avatar Character avatar file name (the character id used by ST)
 * @param {string|null} folderId Target folder id, or null to unassign
 * @returns {boolean} Whether the assignment changed
 */
export function assignCharacter(state, avatar, folderId) {
    if (typeof avatar !== 'string' || avatar.length === 0) {
        return false;
    }

    const isRootTarget = folderId === ROOT_ID;
    const target = isRootTarget ? ROOT_ID : getFolder(state, folderId)?.id;

    if (target === undefined) {
        // Unknown folder id: do not silently unassign the character.
        return false;
    }

    const previous = state.assignments[avatar] ?? null;

    if (target === ROOT_ID) {
        delete state.assignments[avatar];
    } else {
        state.assignments[avatar] = target;
    }

    return previous !== target;
}

/**
 * Returns the folder a character is assigned to.
 * @param {object} state State
 * @param {string} avatar Character avatar file name
 * @returns {string|null} Folder id, or null when unassigned
 */
export function getCharacterFolderId(state, avatar) {
    const folderId = state.assignments[avatar];
    return typeof folderId === 'string' && getFolder(state, folderId) ? folderId : ROOT_ID;
}

/**
 * Lists the avatars assigned to a folder.
 * @param {object} state State
 * @param {string|null} folderId Folder id, or null for "unassigned" is **not** supported here (use `getUnassignedAvatars`)
 * @param {object} [options] Options
 * @param {boolean} [options.includeSubfolders=false] Whether subfolders are included
 * @returns {string[]} Avatar file names
 */
export function getAssignedAvatars(state, folderId, { includeSubfolders = false } = {}) {
    const ids = new Set([folderId, ...(includeSubfolders ? getDescendantIds(state, folderId) : [])]);
    return Object.entries(state.assignments)
        .filter(([, assignedId]) => ids.has(assignedId))
        .map(([avatar]) => avatar);
}

/**
 * Counts the characters assigned to a folder.
 * @param {object} state State
 * @param {string|null} folderId Folder id
 * @param {object} [options] Options
 * @param {boolean} [options.includeSubfolders=false] Whether subfolders are included
 * @returns {number} Number of assigned characters
 */
export function getCharacterCount(state, folderId, { includeSubfolders = false } = {}) {
    return getAssignedAvatars(state, folderId, { includeSubfolders }).length;
}

/**
 * Filters a list of avatars down to those that are not assigned to any folder.
 * @param {object} state State
 * @param {Iterable<string>} avatars Known character avatars
 * @returns {string[]} Avatars without a folder
 */
export function getUnassignedAvatars(state, avatars) {
    return [...avatars].filter(avatar => getCharacterFolderId(state, avatar) === ROOT_ID);
}

/**
 * Checks whether a character is inside a folder (optionally including subfolders).
 * @param {object} state State
 * @param {string} avatar Character avatar file name
 * @param {string|null} folderId Folder id, or null to check "unassigned"
 * @param {object} [options] Options
 * @param {boolean} [options.includeSubfolders=true] Whether subfolders count as inside
 * @returns {boolean} Whether the character is inside
 */
export function isCharacterInFolder(state, avatar, folderId, { includeSubfolders = true } = {}) {
    const assignedId = getCharacterFolderId(state, avatar);

    if (folderId === ROOT_ID) {
        return assignedId === ROOT_ID;
    }

    if (assignedId === folderId) {
        return true;
    }

    return includeSubfolders && assignedId !== ROOT_ID && getDescendantIds(state, folderId).includes(assignedId);
}

/**
 * Removes assignments of characters that no longer exist (deleted or renamed file).
 * @param {object} state State to modify in place
 * @param {Iterable<string>} existingAvatars Known character avatars
 * @returns {number} Number of removed assignments
 */
export function pruneAssignments(state, existingAvatars) {
    const known = new Set(existingAvatars);
    let removed = 0;

    for (const avatar of Object.keys(state.assignments)) {
        if (!known.has(avatar)) {
            delete state.assignments[avatar];
            removed++;
        }
    }

    return removed;
}

/**
 * Keeps assignments valid when a character file is renamed.
 * @param {object} state State to modify in place
 * @param {string} oldAvatar Old avatar file name
 * @param {string} newAvatar New avatar file name
 * @returns {boolean} Whether an assignment was migrated
 */
export function renameCharacterAvatar(state, oldAvatar, newAvatar) {
    if (typeof oldAvatar !== 'string' || typeof newAvatar !== 'string' || !state.assignments[oldAvatar]) {
        return false;
    }

    state.assignments[newAvatar] = state.assignments[oldAvatar];
    delete state.assignments[oldAvatar];
    return true;
}

/**
 * Copies an assignment to another character. Used when a character is duplicated:
 * the original keeps its folder and the copy inherits it (a duplicate is a copy,
 * not a rename - `renameCharacterAvatar` would move the assignment away).
 * @param {object} state State to modify in place
 * @param {string} sourceAvatar Avatar file name of the existing character
 * @param {string} targetAvatar Avatar file name of the new copy
 * @returns {boolean} Whether an assignment was copied
 */
export function copyCharacterAssignment(state, sourceAvatar, targetAvatar) {
    if (typeof sourceAvatar !== 'string' || typeof targetAvatar !== 'string' || sourceAvatar === targetAvatar) {
        return false;
    }

    const folderId = getCharacterFolderId(state, sourceAvatar);
    if (!folderId) {
        return false;
    }

    state.assignments[targetAvatar] = folderId;
    return true;
}

/**
 * Flattens the folder tree into a render-ready list.
 * @param {object} state State
 * @param {string|null} [parentId] Start folder (defaults to the root)
 * @param {number} [depth] Current depth (used internally)
 * @returns {{folder: Folder, depth: number}[]} Folders in display order
 */
export function flattenFolders(state, parentId = ROOT_ID, depth = 0) {
    const result = [];

    for (const folder of getChildren(state, parentId)) {
        result.push({ folder, depth });
        result.push(...flattenFolders(state, folder.id, depth + 1));
    }

    return result;
}

/**
 * Serializes the state for export/backup.
 * @param {object} state State
 * @returns {string} Pretty-printed JSON
 */
export function serializeState(state) {
    return JSON.stringify(
        {
            version: STORE_VERSION,
            exportedAt: new Date().toISOString(),
            folders: state.folders,
            assignments: state.assignments,
            ui: state.ui,
        },
        null,
        4,
    );
}

/**
 * Parses an exported state. Throws on malformed input; unknown/invalid entries are dropped.
 * @param {string|object} input JSON string or already parsed object
 * @returns {object} A valid state
 * @throws {Error} When the input is not valid JSON or does not look like a folder backup
 */
export function parseState(input) {
    let parsed = input;

    if (typeof input === 'string') {
        parsed = JSON.parse(input);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Not a folder backup: expected a JSON object.');
    }

    if (!Array.isArray(parsed.folders)) {
        throw new Error('Not a folder backup: missing "folders" array.');
    }

    const version = Number(parsed.version);
    if (Number.isFinite(version) && version > STORE_VERSION) {
        throw new Error(`Backup was created by a newer version of the extension (v${version}).`);
    }

    return normalizeState(parsed);
}

/**
 * Builds a plain-text tree preview, used by the export summary and for debugging.
 * @param {object} state State
 * @param {string|null} [parentId] Start folder (defaults to the root)
 * @param {number} [depth] Current depth (used internally)
 * @returns {string} Newline-separated tree
 */
export function describeTree(state, parentId = ROOT_ID, depth = 0) {
    const lines = [];

    for (const folder of getChildren(state, parentId)) {
        lines.push(`${'    '.repeat(depth)}${folder.name} (${getCharacterCount(state, folder.id)})`);
        lines.push(...describeTree(state, folder.id, depth + 1).split('\n').filter(Boolean));
    }

    return lines.join('\n');
}
