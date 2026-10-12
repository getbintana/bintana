/*
 * The parts of an `.xlsx` that are not about the order of reading it: what a
 * column's letters are, the text of a string, whether a number format is a
 * date and what a date serial says.
 *
 * **A module, imported by `SheetReader.js`**, which is a `Task`: a worker loads
 * the file of the task class and what that file imports, and nothing else, so
 * a helper the reader needs is reached through an `import` and not by being in
 * the project (docs/plans/modules-plan.md, stage 3).  It is not in
 * `project.json`'s `sources` either: the import is what loads it.
 */

export const RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/* Most a sheet is read to. A table drawn on demand holds nothing, so rows are
 * cheap; the limit is for memory in the message that carries them. */
export const MAX_ROWS = 200000;
export const MAX_COLS = 1000;

/* "AB" -> 27, with A = 0. */
export function columnOf(letters) {
    let n = 0;

    for (const ch of letters)
        n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
}

/* All the text under a shared-string or inline-string element: `<t>` directly, or
 * inside runs (`<r><t>`) when it has formatting. Phonetic hints (`rPh`) are
 * deliberately not read: they are the reading of the text, not the text. */
export function textOf(si) {
    if (!si)
        return "";

    let out = "";

    for (const t of si.FindAll("t"))
        out += t.Text;
    for (const r of si.FindAll("r"))
        for (const t of r.FindAll("t"))
            out += t.Text;
    return out;
}

/* Whether a number format shows a date or a time. The built-in ids are the
 * specification's table (14-22, 27-36, 45-47, 50-58); a custom one is a date if,
 * once what is quoted, escaped or in brackets is taken out, a letter that means
 * a year, month, day, hour or second is left. */
export function isDateFormat(id, code) {
    if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) ||
        (id >= 50 && id <= 58))
        return true;
    if (!code)
        return false;

    const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");

    return /[ymdhs]/i.test(bare);
}

/* A date serial as text. Day 0 is 1899-12-30 -- not 12-31, because the format
 * inherits a leap year 1900 never had, which only matters before March of it --
 * or 1904-01-01 in the workbooks that say so. */
export function dateText(serial, epoch1904) {
    const base = epoch1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
    const days = Math.floor(serial);
    const secs = Math.round((serial - days) * 86400);
    const when = new Date(base + days * 86400000 + secs * 1000);
    const pad  = (n) => String(n).padStart(2, "0");
    const time = `${pad(when.getUTCHours())}:${pad(when.getUTCMinutes())}`
               + (when.getUTCSeconds() ? `:${pad(when.getUTCSeconds())}` : "");

    if (days === 0)
        return time;

    const day = `${when.getUTCFullYear()}-${pad(when.getUTCMonth() + 1)}-${pad(when.getUTCDate())}`;

    return secs ? `${day} ${time}` : day;
}
