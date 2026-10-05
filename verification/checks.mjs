/**
 * Browser verification for the Character Folders extension.
 *
 * Runs the **real** extension file (`index.js`, `style.css`) in Chromium with the
 * real jQuery + jQuery UI from the SillyTavern checkout, against stubbed core
 * modules (see `stubs/`). No package installation and no SillyTavern server are
 * required — it drives the Chromium/Chrome/Edge already present on this machine
 * over the DevTools protocol (see `cdp.mjs`).
 *
 * Usage: `node verification/checks.mjs`
 */

import path from 'node:path';
import fs from 'node:fs';
import { startServer } from './server.mjs';
import { launchBrowser } from './cdp.mjs';

const HERE = import.meta.dirname;
fs.mkdirSync(path.join(HERE, 'screenshots'), { recursive: true });

/** @type {{name: string, ok: boolean, details: string}[]} */
const results = [];

/**
 * Records and prints the outcome of one check.
 * @param {string} name Check name
 * @param {boolean} ok Whether the check passed
 * @param {string} [details=''] Extra information for failures
 * @returns {void}
 */
function check(name, ok, details = '') {
    results.push({ name, ok: Boolean(ok), details });
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && details ? `  (${details})` : ''}`);
}

const { server, url } = await startServer(8124);
const browser = await launchBrowser();
const page = browser.page;
const consoleErrors = page.consoleErrors;

/* ------------------------------------------------------------------ helpers */

/**
 * @returns {Promise<Array<object>>} Rendered tree rows
 */
const rows = () => page.$$eval('#cf_panel .cf-row', elements => elements.map(element => ({
    id: element.getAttribute('data-folder-id'),
    name: element.querySelector('.cf-name')?.textContent?.trim() ?? '',
    count: element.querySelector('.cf-count')?.textContent?.trim() ?? '',
    depth: element.style.getPropertyValue('--cf-depth'),
    open: element.classList.contains('cf-open'),
})));

/**
 * @returns {Promise<string[]>} Names of the character cards in the list
 */
const cards = () => page.$$eval('#rm_print_characters_block .character_select .ch_name', elements => elements.map(element => element.textContent.trim()));

/**
 * Reads the live extension state from the stubbed settings object.
 * @returns {Promise<object>} Folder state
 */
const folderState = () => page.evaluate(() => window.SillyTavern.getContext().extensionSettings['character-folders']);

/**
 * Finds the id of a folder by name.
 * @param {string} name Folder name
 * @returns {Promise<string|null>} Folder id
 */
async function folderId(name) {
    const state = await folderState();
    return state.folders.find(folder => folder.name === name)?.id ?? null;
}

/**
 * Drags one element onto another using real mouse events (jQuery UI needs
 * mousedown/mousemove/mouseup, not HTML5 drag events).
 * @param {string} sourceSelector Source element
 * @param {string} targetSelector Target element
 * @returns {Promise<void>} Resolves after the drop
 */
async function dragOnto(sourceSelector, targetSelector) {
    const source = await page.waitForSelector(sourceSelector);
    const target = await page.waitForSelector(targetSelector);
    const sourceBox = await source.boundingBox();
    const targetBox = await target.boundingBox();
    if (!sourceBox || !targetBox) {
        throw new Error(`Could not resolve drag geometry for ${sourceSelector} -> ${targetSelector}`);
    }

    const from = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
    const to = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 16, from.y + 16, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await page.mouse.move(to.x + 1, to.y + 1, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(200);
}

/**
 * Clicks a tree row (by folder id) on its name area.
 * @param {string|null} id Folder id, or null for the unfiled row
 * @returns {Promise<void>} Resolves after the click
 */
async function clickRow(id) {
    const selector = id === null ? '#cf_panel .cf-row-unassigned .cf-name' : `#cf_panel .cf-row[data-folder-id="${id}"] .cf-name`;
    await page.click(selector);
    await page.waitForTimeout(120);
}

/* ------------------------------------------------------------------- checks */

try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__cf?.ready === true, { timeout: 15000 });

    // 1. Panel is injected into the Character Management panel.
    const panelParent = await page.$eval('#cf_panel', element => element.parentElement?.id);
    check('panel is injected into #rm_characters_block', panelParent === 'rm_characters_block', `parent=${panelParent}`);
    const panelAfterFixedTop = await page.$eval('#cf_panel', element => element.previousElementSibling?.id);
    check('panel is placed right below the fixed header', panelAfterFixedTop === 'charListFixedTop', `previous=${panelAfterFixedTop}`);

    // 2. Filter hook is registered in the core filter chain.
    const filterKeys = await page.evaluate(() => Object.keys(window.__cf.filterFunctions));
    check('filter hook registered in entitiesFilter.filterFunctions', filterKeys.includes('character-folders'), `keys=${filterKeys.join(',')}`);

    // 3. Initial state: one "Unfiled" row with every seeded character.
    let tree = await rows();
    check('unfiled row shows all 5 characters', tree.length === 1 && tree[0].count === '5', JSON.stringify(tree));
    check('character cards carry a drag handle', await page.$$eval('#rm_print_characters_block .cf-card-select', elements => elements.length) === 5);

    // 4. Create two top-level folders through the real UI.
    await page.evaluate(() => { window.__cf.nextInput = 'Fantasy'; });
    await page.click('#cf_panel .cf-new-folder');
    await page.waitForFunction(() => document.querySelectorAll('#cf_panel .cf-row').length === 2);
    await page.evaluate(() => { window.__cf.nextInput = 'SciFi'; });
    await page.click('#cf_panel .cf-new-folder');
    await page.waitForFunction(() => document.querySelectorAll('#cf_panel .cf-row').length === 3);
    tree = await rows();
    check('two folders created', tree.map(row => row.name).join(',') === 'Unfiled,Fantasy,SciFi', JSON.stringify(tree.map(row => row.name)));

    // 5. Create a subfolder through the folder action menu (real Popup flow).
    const fantasyId = await folderId('Fantasy');
    await page.evaluate(() => { window.__cf.nextPopupResult = 1001; window.__cf.nextInput = 'Elves'; });
    await page.click(`#cf_panel .cf-row[data-folder-id="${fantasyId}"] .cf-row-menu`);
    await page.waitForFunction(() => [...document.querySelectorAll('#cf_panel .cf-name')].some(element => element.textContent.trim() === 'Elves'));
    tree = await rows();
    const elvesRow = tree.find(row => row.name === 'Elves');
    check('subfolder is nested (depth 1)', elvesRow?.depth === '1', JSON.stringify(elvesRow));
    check('folder action menu offered the expected buttons', await page.evaluate(() => window.__cf.popupCalls.at(-1)?.buttons?.includes('New subfolder')));

    // 6. Drag a character card onto a folder.
    const ariaGrip = '#rm_print_characters_block .character_select[data-chid="0"] .cf-card-select';
    await dragOnto(ariaGrip, `#cf_panel .cf-row[data-folder-id="${fantasyId}"]`);
    let state = await folderState();
    check('character is assigned to the folder (exactly one)', state.assignments['Aria.png'] === fantasyId, JSON.stringify(state.assignments));
    check('dragged character disappeared from the root list', !(await cards()).includes('Aria'), (await cards()).join(','));
    tree = await rows();
    check('folder counter updated to 1', tree.find(row => row.name === 'Fantasy')?.count === '1', JSON.stringify(tree.find(row => row.name === 'Fantasy')));

    // 7. Open the folder -> list is filtered to its content, breadcrumb appears.
    await clickRow(fantasyId);
    check('opening a folder filters the character list', (await cards()).join(',') === 'Aria', (await cards()).join(','));
    const breadcrumb = await page.$eval('#cf_panel .cf-breadcrumb', element => ({ hidden: element.classList.contains('cf-hidden'), text: element.textContent.trim() }));
    check('breadcrumb shows the open folder', !breadcrumb.hidden && breadcrumb.text.includes('Fantasy'), JSON.stringify(breadcrumb));
    tree = await rows();
    check('open folder is highlighted', tree.find(row => row.name === 'Fantasy')?.open === true);

    // 8. Rename a folder inline.
    const scifiId = await folderId('SciFi');
    await page.dblclick(`#cf_panel .cf-row[data-folder-id="${scifiId}"] .cf-name`);
    await page.waitForSelector('#cf_panel .cf-name-input');
    await page.fill('#cf_panel .cf-name-input', 'Science Fiction');
    await page.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('#cf_panel .cf-name')].some(element => element.textContent.trim() === 'Science Fiction'));
    check('inline rename works', (await folderId('Science Fiction')) === scifiId);

    // 9. Drag a folder into another folder.
    const renamedId = await folderId('Science Fiction');
    await dragOnto(`#cf_panel .cf-row[data-folder-id="${renamedId}"]`, `#cf_panel .cf-row[data-folder-id="${fantasyId}"]`);
    state = await folderState();
    check('folder was nested into the target folder', state.folders.find(folder => folder.id === renamedId)?.parentId === fantasyId);
    tree = await rows();
    check('nested folder renders with depth 1', tree.find(row => row.name === 'Science Fiction')?.depth === '1');

    // 10. A folder cannot be moved into its own subfolder.
    await page.evaluate(async () => {
        const state = window.SillyTavern.getContext().extensionSettings['character-folders'];
        window.__cf.beforeCycle = JSON.stringify(state.folders.find(folder => folder.name === 'Fantasy'));
    });
    await dragOnto(`#cf_panel .cf-row[data-folder-id="${fantasyId}"]`, `#cf_panel .cf-row[data-folder-id="${renamedId}"]`);
    const cyclePrevented = await page.evaluate(() => {
        const state = window.SillyTavern.getContext().extensionSettings['character-folders'];
        const fantasy = state.folders.find(folder => folder.name === 'Fantasy');
        return JSON.stringify(fantasy) === window.__cf.beforeCycle;
    });
    check('cycle prevention: folder cannot be dropped into its own subfolder', cyclePrevented);

    // 11. Back to the root, then the root-only filter rule.
    await page.click('#cf_panel .cf-crumb-root');
    await page.waitForTimeout(150);
    check('root view hides filed characters', (await cards()).join(',') === 'Borin,Cleo,Dorn,Echo', (await cards()).join(','));

    // 12. Options toggles drive the filter.
    await page.click('#cf_panel .cf-options');
    await page.waitForSelector('#cf_opt_all_in_root');
    await page.click('#cf_opt_all_in_root');
    await page.waitForTimeout(150);
    check('"show all in root" shows every character again', (await cards()).length === 5, (await cards()).join(','));
    await page.click('#cf_opt_all_in_root');
    await page.waitForTimeout(150);
    check('turning it off restores the unfiled-only view', (await cards()).length === 4, (await cards()).join(','));

    // 13. Delete a folder: nothing is lost, content moves up.
    const elvesId = await folderId('Elves');
    await page.evaluate(() => { window.__cf.nextPopupResult = 1007; window.__cf.nextConfirm = true; });
    await page.click(`#cf_panel .cf-row[data-folder-id="${elvesId}"] .cf-row-menu`);
    await page.waitForFunction(id => !document.querySelector(`#cf_panel .cf-row[data-folder-id="${id}"]`), elvesId);
    check('deleted folder is gone', (await folderId('Elves')) === null);

    // 14. Reset removes everything without touching the characters.
    await page.click('#cf_panel .cf-options');
    await page.waitForSelector('.cf-act-reset');
    await page.evaluate(() => { window.__cf.nextConfirm = true; });
    await page.click('.cf-act-reset');
    await page.waitForTimeout(200);
    state = await folderState();
    tree = await rows();
    check('reset removes all folders and assignments', state.folders.length === 0 && Object.keys(state.assignments).length === 0);
    check('only the unfiled row remains after reset', tree.length === 1 && tree[0].name === 'Unfiled');
    check('all characters are back in the list', (await cards()).length === 5);

    // 15. Hygiene checks.
    const saveCount = await page.evaluate(() => window.__cf.saveCount);
    check('state was persisted through saveSettingsDebounced', saveCount > 0, `saveCount=${saveCount}`);
    const toasts = await page.evaluate(() => window.__cf.toasts);
    check('user feedback was shown as toasts', toasts.length > 0, JSON.stringify(toasts.slice(0, 2)));
    check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | '));

    // 16. Environment of the target installation: grid view + a foreign "Browse"
    // button inside the search form (like NemoPresetExt adds it).
    const gridMode = await page.evaluate(() => document.body.classList.contains('charListGrid'));
    check('harness runs in grid view (charListGrid)', gridMode === true);
    const browseButton = await page.$eval('#nemo-char-browse-btn', element => element.isConnected && element.textContent.trim());
    check('foreign Browse button in the search form is untouched', browseButton === 'Browse', String(browseButton));
    const panelAboveList = await page.evaluate(() => {
        const panel = document.getElementById('cf_panel');
        const list = document.getElementById('rm_print_characters_block');
        return Boolean(panel && list && (panel.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    check('folder panel renders above the character list', panelAboveList);
    const gripInGrid = await page.$$eval('#rm_print_characters_block .character_select .cf-card-select', elements => elements.filter(element => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
    }).length);
    check('drag handles stay clickable in grid view', gripInGrid === 5, `visible grips: ${gripInGrid}`);

    // 17. Screenshots for visual review.
    const clearPopups = () => page.evaluate(() => window.jQuery('#cf_popup_host').empty());
    await clearPopups();
    await page.screenshot({ path: path.join(HERE, 'screenshots', 'grid-mode-full.png') });
    await page.screenshotElement('#cf_panel', { path: path.join(HERE, 'screenshots', 'panel-grid-mode.png') });
    await page.evaluate(() => document.body.classList.remove('charListGrid'));
    await page.waitForTimeout(150);
    await page.evaluate(() => { window.__cf.nextInput = 'Fantasy'; });
    await page.click('#cf_panel .cf-new-folder');
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.__cf.nextInput = 'SciFi'; });
    await page.click('#cf_panel .cf-new-folder');
    await page.waitForFunction(() => document.querySelectorAll('#cf_panel .cf-row').length === 3);
    await clearPopups();
    await page.screenshot({ path: path.join(HERE, 'screenshots', 'list-mode-full.png') });
    await page.screenshotElement('#cf_panel', { path: path.join(HERE, 'screenshots', 'panel-list-mode.png') });
    check('screenshots written', true);

    // 18. Selection + bulk move (the "select, then move" workflow).
    const fantasy = await folderId('Fantasy');
    const scifi = await folderId('SciFi');
    const selectControl = index => `#rm_print_characters_block .character_select[data-chid="${index}"] .cf-card-select`;

    await page.click(selectControl(0));
    check('clicking the card checkbox selects a character',
        await page.$eval('#cf_panel .cf-selection .cf-sel-count', element => element.textContent.includes('1 selected')),
        await page.$eval('#cf_panel .cf-selection', element => element.textContent.trim()));
    check('the selected card is highlighted',
        await page.$eval('#rm_print_characters_block .character_select[data-chid="0"]', element => element.classList.contains('cf-selected')));
    check('folder rows advertise themselves as drop targets',
        await page.$$eval('#cf_panel .cf-row.cf-movetarget', elements => elements.length) === 3,
        String(await page.$$eval('#cf_panel .cf-row.cf-movetarget', elements => elements.length)));

    await page.click(selectControl(1));
    check('a second click adds to the selection',
        await page.$eval('#cf_panel .cf-selection .cf-sel-count', element => element.textContent.includes('2 selected')),
        await page.$eval('#cf_panel .cf-selection', element => element.textContent.trim()));
    await page.screenshot({ path: path.join(HERE, 'screenshots', 'selection-mode-full.png') });
    await page.screenshotElement('#cf_panel', { path: path.join(HERE, 'screenshots', 'panel-selection.png') });

    // Every content change must hit the settings file immediately (not just debounced).
    const savesBeforeMove = await page.evaluate(() => window.__cf.immediateSaves ?? 0);
    await clickRow(scifi);
    const savesAfterMove = await page.evaluate(() => window.__cf.immediateSaves ?? 0);
    check('a move writes the settings file immediately',
        savesAfterMove > savesBeforeMove,
        `before=${savesBeforeMove} after=${savesAfterMove}`);
    let afterMove = await folderState();
    check('clicking a folder moves the whole selection',
        afterMove.assignments['Aria.png'] === scifi && afterMove.assignments['Borin.png'] === scifi,
        JSON.stringify(afterMove.assignments));
    check('the folder counter shows both characters',
        (await rows()).find(row => row.name === 'SciFi')?.count === '2',
        JSON.stringify((await rows()).find(row => row.name === 'SciFi')));
    check('the selection is cleared after moving',
        await page.$eval('#cf_panel .cf-selection', element => element.textContent.includes('moved to')),
        await page.$eval('#cf_panel .cf-selection', element => element.textContent.trim()));

    await page.click('#cf_panel .cf-selection .cf-sel-undo');
    afterMove = await folderState();
    check('undo restores the previous folder', Object.keys(afterMove.assignments).length === 0, JSON.stringify(afterMove.assignments));
    check('the bar disappears once there is nothing left to undo',
        await page.$eval('#cf_panel .cf-selection', element => element.classList.contains('cf-hidden')));

    // 19. "All shown" + move everything at once, plus dismissing the undo offer.
    await page.click(selectControl(0));
    await page.click('#cf_panel .cf-selection .cf-sel-all');
    check('"All shown" selects every rendered character',
        await page.$eval('#cf_panel .cf-selection .cf-sel-count', element => element.textContent.includes('5 selected')),
        await page.$eval('#cf_panel .cf-selection', element => element.textContent.trim()));
    await clickRow(fantasy);
    const allMoved = await folderState();
    check('all five characters can be filed with two clicks', Object.keys(allMoved.assignments).length === 5, JSON.stringify(allMoved.assignments));
    await page.click('#cf_panel .cf-selection .cf-sel-undo');
    check('undo reverts the bulk move completely', Object.keys((await folderState()).assignments).length === 0);

    // Dismissing the undo offer keeps the move, it just removes the button.
    await page.click(selectControl(0));
    await clickRow(fantasy);
    check('one character is filed again for the dismiss test',
        Object.keys((await folderState()).assignments).length === 1,
        JSON.stringify((await folderState()).assignments));
    await page.click('#cf_panel .cf-selection .cf-sel-clear');
    check('dismissing the undo bar hides it but keeps the move',
        await page.$eval('#cf_panel .cf-selection', element => element.classList.contains('cf-hidden'))
        && Object.keys((await folderState()).assignments).length === 1);

    // Clean slate: open the folder and take the filed character out again via the
    // "Unfiled" row (which is also a move target).
    await clickRow(fantasy);
    check('opening a folder shows only its content', (await cards()).join(',') === 'Aria', (await cards()).join(','));
    await page.click(selectControl(0));
    await clickRow(null);
    check('the unfiled row takes characters out of a folder',
        Object.keys((await folderState()).assignments).length === 0,
        JSON.stringify((await folderState()).assignments));
    await page.click('#cf_panel .cf-selection .cf-sel-clear');
    await page.click('#cf_panel .cf-crumb-root');
    await page.waitForTimeout(150);

    // 20. The "Move to…" dialog with deferred popup interaction.
    await page.click(selectControl(2));
    await page.evaluate(() => { window.__cf.deferPopups = true; });
    await page.click('#cf_panel .cf-selection .cf-sel-move');
    await page.waitForSelector('#cf_popup_host .cf-pick-row');
    const pickRows = await page.$$eval('#cf_popup_host .cf-pick-row', elements => elements.length);
    check('the folder picker lists Unfiled plus every folder', pickRows === 3, `rows=${pickRows}`);
    await page.evaluate(id => {
        const input = document.querySelector(`#cf_popup_host input[name="cf_pick"][value="${id}"]`);
        input.checked = true;
        window.__cf.resolvePopup(1);
    }, scifi);
    await page.waitForTimeout(200);
    check('picking a folder in the dialog moves the selected character',
        (await folderState()).assignments['Cleo.png'] === scifi,
        JSON.stringify((await folderState()).assignments));
    await page.evaluate(() => { window.__cf.deferPopups = false; });

    // 21. Turning the click-to-move behaviour off makes folder clicks navigate again.
    await page.click('#cf_panel .cf-options');
    await page.waitForSelector('#cf_opt_click_moves');
    await page.click('#cf_opt_click_moves');
    await page.click(selectControl(3));
    const beforeNavigate = JSON.stringify((await folderState()).assignments);
    await clickRow(fantasy);
    const afterNavigate = await folderState();
    check('with the option off, clicking a folder opens it instead of moving',
        afterNavigate.assignments && JSON.stringify(afterNavigate.assignments) === beforeNavigate && afterNavigate.ui.openFolderId === fantasy,
        JSON.stringify(afterNavigate.ui));
    await page.click('#cf_opt_click_moves');
    await page.evaluate(() => { window.jQuery('#cf_popup_host').empty(); });
    await page.click('#cf_panel .cf-selection .cf-sel-clear');
    await page.click('#cf_panel .cf-crumb-root');
    await page.waitForTimeout(150);
    check('the panel is still healthy after the selection tests',
        (await rows()).length === 3 && (await cards()).length === 4,
        `rows=${(await rows()).length} cards=${(await cards()).length}`);

    // 22. Regression for the reported bug: SillyTavern initialises extensions
    // (script.js:747) *before* the character list is fetched (script.js:759). An
    // earlier version pruned assignments against the empty list and wiped them.
    await page.goto(`${url}?state=preset`);
    await page.waitForFunction(() => window.__cf?.ready === true, { timeout: 15000 });
    const presetState = await folderState();
    check('saved assignments survive an init with an empty character list',
        Object.keys(presetState.assignments).length === 2 && presetState.assignments['Aria.png'] === 'f_preset',
        JSON.stringify(presetState.assignments));
    check('the saved folder survives as well',
        presetState.folders.length === 1 && presetState.folders[0].name === 'Preset',
        JSON.stringify(presetState.folders.map(folder => folder.name)));
    check('missing ui defaults are filled in without dropping the state',
        presetState.ui.clickFolderMovesSelection === true && presetState.ui.includeSubfolders === true,
        JSON.stringify(presetState.ui));

    await page.evaluate(() => window.__cf.seedCharacters([
        { name: 'Aria', avatar: 'Aria.png' },
        { name: 'Borin', avatar: 'Borin.png' },
        { name: 'Cleo', avatar: 'Cleo.png' },
        { name: 'Dorn', avatar: 'Dorn.png' },
        { name: 'Echo', avatar: 'Echo.png' },
    ]));
    await page.waitForTimeout(250);
    check('the folder counter reflects the restored assignments',
        (await rows()).find(row => row.name === 'Preset')?.count === '2',
        JSON.stringify((await rows()).find(row => row.name === 'Preset')));
    check('only unfiled characters are shown at the root',
        (await cards()).join(',') === 'Cleo,Dorn,Echo',
        (await cards()).join(','));
    check('the restored character is really inside the folder',
        await page.evaluate(async () => {
            const context = window.SillyTavern.getContext();
            const cards = document.querySelectorAll('#rm_print_characters_block .character_select');
            const state = context.extensionSettings['character-folders'];
            return cards.length === 3 && Object.keys(state.assignments).length === 2;
        }));
} catch (error) {
    check('harness completed without exceptions', false, String(error?.stack ?? error));
} finally {
    await browser.close();
    server.close();
}

const failed = results.filter(result => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
    console.log('Failed checks:');
    for (const failure of failed) {
        console.log(` - ${failure.name}${failure.details ? `: ${failure.details}` : ''}`);
    }
}
process.exit(failed.length > 0 ? 1 : 0);
