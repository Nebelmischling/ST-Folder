/**
 * Test double for `/scripts/utils.js` — only the helper the extension imports.
 * Mirrors the behaviour of the core `escapeHtml`.
 */

/**
 * Escapes HTML special characters.
 * @param {string} text Text to escape
 * @returns {string} Escaped text
 */
export function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
