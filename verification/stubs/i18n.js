/**
 * Test double for `/scripts/i18n.js`. The harness runs in English, so `t` only
 * has to interpolate its tagged template without any dictionary lookup.
 */

/**
 * Tagged template that interpolates its values.
 * @param {TemplateStringsArray} strings Template strings
 * @param {...any} values Interpolated values
 * @returns {string} Interpolated string
 */
export function t(strings, ...values) {
    return strings.reduce((result, part, index) => result + part + (index < values.length ? String(values[index]) : ''), '');
}

/**
 * @param {string} text Text
 * @returns {string} The same text
 */
export function translate(text) {
    return text;
}

/**
 * @returns {string} Fixed locale
 */
export function getCurrentLocale() {
    return 'en-us';
}
