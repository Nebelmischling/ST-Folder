/**
 * Unit tests for the pure folder logic.
 *
 * Run with: `node --test folder-store.test.js` (Node 18+), from this directory.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    STORE_VERSION,
    createEmptyState,
    normalizeState,
    generateId,
    sanitizeFolderName,
    createFolder,
    renameFolder,
    setFolderColor,
    setFolderCollapsed,
    deleteFolder,
    moveFolder,
    assignCharacter,
    getCharacterFolderId,
    getAssignedAvatars,
    getCharacterCount,
    getUnassignedAvatars,
    isCharacterInFolder,
    pruneAssignments,
    renameCharacterAvatar,
    copyCharacterAssignment,
    getChildren,
    getFolderPath,
    getDescendantIds,
    flattenFolders,
    serializeState,
    parseState,
    describeTree,
} from './folder-store.js';

/**
 * Builds a small fixture: Root > (Fantasy > Elves, SciFi), with two characters.
 * @returns {{state: object, fantasy: object, elves: object, scifi: object}} Fixture
 */
function fixture() {
    const state = createEmptyState();
    const fantasy = createFolder(state, { name: 'Fantasy' });
    const elves = createFolder(state, { name: 'Elves', parentId: fantasy.id });
    const scifi = createFolder(state, { name: 'SciFi' });
    return { state, fantasy, elves, scifi };
}

test('empty state is valid and versioned', () => {
    const state = createEmptyState();
    assert.equal(state.version, STORE_VERSION);
    assert.deepEqual(state.folders, []);
    assert.deepEqual(state.assignments, {});
    assert.equal(state.ui.openFolderId, null);
});

test('generateId returns unique non-empty ids', () => {
    const ids = new Set();
    for (let index = 0; index < 500; index++) {
        ids.add(generateId());
    }
    assert.equal(ids.size, 500);
    for (const id of ids) {
        assert.equal(typeof id, 'string');
        assert.ok(id.length > 2);
    }
});

test('sanitizeFolderName trims, strips control chars and limits length', () => {
    assert.equal(sanitizeFolderName('  Fantasy  '), 'Fantasy');
    assert.equal(sanitizeFolderName('Bad\u0000Name'), 'BadName');
    assert.equal(sanitizeFolderName('x'.repeat(200)).length, 60);
    assert.equal(sanitizeFolderName(42), '');
    assert.equal(sanitizeFolderName(null), '');
});

test('normalizeState drops invalid folders, dangling parents and cycles', () => {
    const state = normalizeState({
        version: 1,
        folders: [
            { id: 'a', name: 'A', parentId: 'missing' },
            { id: 'b', name: 'B', parentId: 'c' },
            { id: 'c', name: 'C', parentId: 'b' },
            { id: 'a', name: 'Duplicate id' },
            { name: 'No id' },
            null,
            'garbage',
        ],
        assignments: { 'x.png': 'missing', 'y.png': 'a', '': 'a' },
    });

    const ids = state.folders.map(folder => folder.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(state.folders.length, 4);
    assert.equal(state.folders.find(folder => folder.name === 'A').parentId, null);
    // The b<->c cycle is broken, so neither is its own ancestor.
    for (const folder of state.folders) {
        assert.ok(!getDescendantIds(state, folder.id).includes(folder.id));
    }
    assert.deepEqual(state.assignments, { 'y.png': 'a' });
});

test('normalizeState tolerates garbage input', () => {
    for (const input of [null, undefined, 0, 'nope', [], { folders: 'x' }]) {
        const state = normalizeState(input);
        assert.equal(state.version, STORE_VERSION);
        assert.deepEqual(state.folders, []);
    }
});

test('normalizeState makes sibling names unique and keeps order dense', () => {
    const state = normalizeState({
        folders: [
            { id: 'a', name: 'Same', parentId: null, order: 5 },
            { id: 'b', name: 'same', parentId: null, order: 9 },
        ],
    });
    const names = getChildren(state, null).map(folder => folder.name);
    assert.deepEqual(names, ['Same', 'same (2)']);
    assert.deepEqual(getChildren(state, null).map(folder => folder.order), [0, 1]);
});

test('createFolder requires a name and keeps siblings unique', () => {
    const state = createEmptyState();
    assert.equal(createFolder(state, { name: '   ' }), null);

    const first = createFolder(state, { name: 'Bots' });
    const second = createFolder(state, { name: 'Bots' });
    assert.equal(first.name, 'Bots');
    assert.equal(second.name, 'Bots (2)');
    assert.equal(state.folders.length, 2);
});

test('createFolder with unknown parent falls back to root', () => {
    const state = createEmptyState();
    const folder = createFolder(state, { name: 'Orphan', parentId: 'does-not-exist' });
    assert.equal(folder.parentId, null);
});

test('renameFolder renames and de-duplicates, rejects invalid input', () => {
    const { state, fantasy, scifi } = fixture();
    assert.equal(renameFolder(state, scifi.id, 'Fantasy').name, 'Fantasy (2)');
    assert.equal(renameFolder(state, fantasy.id, '  Mythos ').name, 'Mythos');
    assert.equal(renameFolder(state, fantasy.id, '   '), null);
    assert.equal(renameFolder(state, 'nope', 'X'), null);
});

test('setFolderColor and setFolderCollapsed only touch existing folders', () => {
    const { state, fantasy } = fixture();
    assert.equal(setFolderColor(state, fantasy.id, '#ff0000'), true);
    assert.equal(fantasy.color, '#ff0000');
    assert.equal(setFolderCollapsed(state, fantasy.id, true), true);
    assert.equal(fantasy.collapsed, true);
    assert.equal(setFolderColor(state, 'nope', '#fff'), false);
    assert.equal(setFolderCollapsed(state, 'nope', true), false);
});

test('moveFolder prevents cycles', () => {
    const { state, fantasy, elves } = fixture();
    assert.equal(moveFolder(state, fantasy.id, fantasy.id), false);
    assert.equal(moveFolder(state, fantasy.id, elves.id), false);
    assert.equal(fantasy.parentId, null);
    assert.equal(elves.parentId, fantasy.id);
});

test('moveFolder reorders and reparents', () => {
    const { state, fantasy, scifi } = fixture();
    const third = createFolder(state, { name: 'Anime' });
    assert.deepEqual(getChildren(state, null).map(folder => folder.name), ['Fantasy', 'SciFi', 'Anime']);

    // Move "Anime" to the front of the root list.
    assert.equal(moveFolder(state, third.id, null, 0), true);
    assert.deepEqual(getChildren(state, null).map(folder => folder.name), ['Anime', 'Fantasy', 'SciFi']);

    // Move "SciFi" into "Fantasy" at the front.
    assert.equal(moveFolder(state, scifi.id, fantasy.id, 0), true);
    assert.deepEqual(getChildren(state, fantasy.id).map(folder => folder.name), ['SciFi', 'Elves']);
    assert.deepEqual(getChildren(state, null).map(folder => folder.name), ['Anime', 'Fantasy']);

    // Out-of-range index appends.
    assert.equal(moveFolder(state, scifi.id, null, 99), true);
    assert.deepEqual(getChildren(state, null).map(folder => folder.name), ['Anime', 'Fantasy', 'SciFi']);
});

test('deleteFolder keeps data: subfolders move up, direct characters follow the parent', () => {
    const { state, fantasy, elves } = fixture();
    assignCharacter(state, 'aria.png', elves.id);
    assignCharacter(state, 'bob.png', fantasy.id);

    // Only "bob.png" is assigned directly to the deleted folder, so only it is moved.
    const summary = deleteFolder(state, fantasy.id);
    assert.deepEqual(summary, { parentId: null, characters: 1, folders: 1 });
    assert.equal(getCharacterFolderId(state, 'bob.png'), null);
    // The subfolder survives and keeps its own character.
    assert.equal(elves.parentId, null);
    assert.equal(getCharacterFolderId(state, 'aria.png'), elves.id);
    assert.deepEqual(getChildren(state, null).map(folder => folder.name).sort(), ['Elves', 'SciFi']);
});

test('deleteFolder moves content into the grandparent when nested', () => {
    const { state, fantasy, elves } = fixture();
    const woodElves = createFolder(state, { name: 'Wood Elves', parentId: elves.id });
    assignCharacter(state, 'legolas.png', woodElves.id);

    const summary = deleteFolder(state, elves.id);
    assert.equal(summary.parentId, fantasy.id);
    assert.equal(summary.folders, 1);
    assert.equal(woodElves.parentId, fantasy.id);
    // The surviving subfolder keeps its character.
    assert.equal(getCharacterFolderId(state, 'legolas.png'), woodElves.id);
    assert.equal(deleteFolder(state, 'nope'), null);
});

test('deleteFolder resets the open folder to its parent', () => {
    const { state, fantasy, elves } = fixture();
    state.ui.openFolderId = elves.id;
    deleteFolder(state, elves.id);
    assert.equal(state.ui.openFolderId, fantasy.id);
});

test('assignCharacter enforces exactly one folder per character', () => {
    const { state, fantasy, scifi } = fixture();
    assert.equal(assignCharacter(state, 'aria.png', fantasy.id), true);
    assert.equal(getCharacterFolderId(state, 'aria.png'), fantasy.id);

    // Moving replaces the old assignment instead of adding a second one.
    assert.equal(assignCharacter(state, 'aria.png', scifi.id), true);
    assert.equal(getCharacterFolderId(state, 'aria.png'), scifi.id);
    assert.equal(Object.keys(state.assignments).length, 1);
    assert.deepEqual(getAssignedAvatars(state, fantasy.id), []);

    // Same folder again is a no-op.
    assert.equal(assignCharacter(state, 'aria.png', scifi.id), false);

    // Unassigning works.
    assert.equal(assignCharacter(state, 'aria.png', null), true);
    assert.equal(getCharacterFolderId(state, 'aria.png'), null);
    assert.deepEqual(state.assignments, {});
});

test('assignCharacter ignores unknown folders and empty avatars', () => {
    const state = createEmptyState();
    assert.equal(assignCharacter(state, 'aria.png', 'ghost-folder'), false);
    assert.deepEqual(state.assignments, {});
    assert.equal(assignCharacter(state, '', null), false);
    assert.equal(assignCharacter(state, null, null), false);
});

test('counts, unassigned list and subtree membership', () => {
    const { state, fantasy, elves, scifi } = fixture();
    assignCharacter(state, 'aria.png', elves.id);
    assignCharacter(state, 'bob.png', fantasy.id);
    assignCharacter(state, 'carl.png', scifi.id);

    assert.equal(getCharacterCount(state, fantasy.id), 1);
    assert.equal(getCharacterCount(state, fantasy.id, { includeSubfolders: true }), 2);
    assert.deepEqual(getAssignedAvatars(state, fantasy.id, { includeSubfolders: true }).sort(), ['aria.png', 'bob.png']);
    assert.deepEqual(getUnassignedAvatars(state, ['aria.png', 'dora.png']), ['dora.png']);
    assert.equal(getCharacterCount(state, null), 0);

    assert.equal(isCharacterInFolder(state, 'aria.png', fantasy.id), true);
    assert.equal(isCharacterInFolder(state, 'aria.png', elves.id), true);
    assert.equal(isCharacterInFolder(state, 'aria.png', fantasy.id, { includeSubfolders: false }), false);
    assert.equal(isCharacterInFolder(state, 'carl.png', fantasy.id), false);
    assert.equal(isCharacterInFolder(state, 'dora.png', null), true);
});

test('pruneAssignments removes vanished characters', () => {
    const { state, fantasy } = fixture();
    assignCharacter(state, 'aria.png', fantasy.id);
    assignCharacter(state, 'gone.png', fantasy.id);
    assert.equal(pruneAssignments(state, ['aria.png']), 1);
    assert.deepEqual(Object.keys(state.assignments), ['aria.png']);
});

test('renameCharacterAvatar migrates the assignment', () => {
    const { state, fantasy } = fixture();
    assignCharacter(state, 'aria.png', fantasy.id);
    assert.equal(renameCharacterAvatar(state, 'aria.png', 'aria_v2.png'), true);
    assert.equal(getCharacterFolderId(state, 'aria_v2.png'), fantasy.id);
    assert.equal(getCharacterFolderId(state, 'aria.png'), null);
    assert.equal(renameCharacterAvatar(state, 'unknown.png', 'x.png'), false);
});

test('getFolderPath and flattenFolders describe the tree', () => {
    const { state, fantasy, elves } = fixture();
    const deep = createFolder(state, { name: 'Deep', parentId: elves.id });

    assert.deepEqual(getFolderPath(state, deep.id).map(folder => folder.name), ['Fantasy', 'Elves', 'Deep']);
    assert.deepEqual(getFolderPath(state, null), []);
    assert.deepEqual(getFolderPath(state, 'nope'), []);

    const flat = flattenFolders(state);
    assert.deepEqual(flat.map(entry => `${entry.depth}:${entry.folder.name}`), ['0:Fantasy', '1:Elves', '2:Deep', '0:SciFi']);
});

test('serialize/parse round-trips the state', () => {
    const { state, fantasy, elves } = fixture();
    assignCharacter(state, 'aria.png', elves.id);

    const restored = parseState(serializeState(state));
    assert.deepEqual(restored.folders.map(folder => folder.name), state.folders.map(folder => folder.name));
    assert.deepEqual(restored.assignments, { 'aria.png': elves.id });
    assert.equal(restored.folders.find(folder => folder.name === 'Elves').parentId, fantasy.id);
});

test('parseState rejects malformed and newer backups', () => {
    assert.throws(() => parseState('{not json'), /JSON|Unexpected/i);
    assert.throws(() => parseState('"a string"'), /Not a folder backup/);
    assert.throws(() => parseState({ version: 1 }), /missing "folders"/);
    assert.throws(() => parseState({ version: 99, folders: [] }), /newer version/);
});

test('parseState accepts a backup without version', () => {
    const state = parseState({ folders: [{ id: 'a', name: 'A' }] });
    assert.equal(state.folders.length, 1);
});

test('describeTree renders indented names with counts', () => {
    const { state, elves } = fixture();
    assignCharacter(state, 'aria.png', elves.id);
    assert.equal(describeTree(state), 'Fantasy (0)\n    Elves (1)\nSciFi (0)');
});

test('copyCharacterAssignment copies without moving the original', () => {
    const { state, fantasy } = fixture();
    assignCharacter(state, 'aria.png', fantasy.id);

    assert.equal(copyCharacterAssignment(state, 'aria.png', 'aria_copy.png'), true);
    assert.equal(getCharacterFolderId(state, 'aria.png'), fantasy.id, 'the original keeps its folder');
    assert.equal(getCharacterFolderId(state, 'aria_copy.png'), fantasy.id, 'the copy inherits the folder');

    assert.equal(copyCharacterAssignment(state, 'aria.png', 'aria.png'), false, 'same avatar is a no-op');
    assert.equal(copyCharacterAssignment(state, 'missing.png', 'x.png'), false, 'unknown source copies nothing');
    assert.equal(getCharacterFolderId(state, 'x.png'), null);
});
