/*
 * Snippets: a word typed in the editor, and Tab, becomes the shape it stands for.
 *
 * **The runtime does the hard half and this does the small one.** The editor's
 * `InsertSnippet(template)` is GtkSourceView's own: `${1:name}` is a place with
 * a default that is selected when the cursor arrives, the same number twice is
 * one place typed once and shown in each, `$0` is where the cursor ends, and Tab
 * and Shift+Tab move between places by themselves while the snippet lasts. What
 * is left for the IDE is to know *which word* is a trigger and to put it away
 * before the template goes in, which is a table and eleven lines -- no second
 * implementation of placeholders, and no private API: an application with an
 * editor of its own gets the same verb.
 *
 * **A trigger is a whole word, and only where a word could start.** `for` at the
 * start of a line or after a space expands; `x.for`, `before` and `$for` do not,
 * because each of those is a name and Tab there is an indent, which is what it
 * did before this file existed and what a person typing an identifier means.
 * With a selection there is nothing to expand either: that is the Tab of a
 * snippet that is already active, selecting its next place, and the editor
 * answers it itself.
 *
 * Only for `js`: the table is JavaScript, and a JSON file or a `.po` has no `for`.
 * The templates are written the way this language's code is written here --
 * four spaces, `const`, `Timer.After(delay, tick)` with the delay first -- so
 * what comes out is what the rest of the file already looks like.
 */
"use strict";

/* The trigger and what it becomes. Written at column 0: the editor puts a
 * template at the indentation of the line it lands on. */
const SNIPPETS_JS = {
    "if":     "if (${1:condition}) {\n    $0\n}",
    "ife":    "if (${1:condition}) {\n    $2\n} else {\n    $0\n}",
    "for":    "for (let ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n    $0\n}",
    "forof":  "for (const ${1:item} of ${2:items}) {\n    $0\n}",
    "while":  "while (${1:condition}) {\n    $0\n}",
    "switch": "switch (${1:value}) {\n    case ${2:first}:\n        $0\n        break;\n    default:\n        break;\n}",
    "try":    "try {\n    $0\n} catch (${1:e}) {\n    $2\n}",
    "fn":     "function ${1:name}(${2}) {\n    $0\n}",
    "cls":    "class ${1:Name} {\n    constructor(${2}) {\n        $0\n    }\n}",
    "form":   "class ${1:Name} extends Form {\n    Form_Open() {\n        $0\n    }\n}",
    "on":     "${1:Button1}_${2:Click}(${3}) {\n    $0\n}",
    "after":  "Timer.After(${1:1000}, () => {\n    $0\n});",
    "every":  "Timer.Every(${1:1000}, () => {\n    $0\n});",
};

/* A letter, a digit or `_`: what an identifier is made of.  Spelled out, since
 * this language has no `RegExp` to ask. */
function isWordChar(c) {
    return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") ||
           (c >= "0" && c <= "9") || c === "_";
}

export class Snippets {
    /* The triggers a language has, in the order they were written. `[]` for a
     * language with none -- which is every one but `js`. */
    static triggers(language) {
        return language === "js" ? Dictionary.Keys(SNIPPETS_JS) : [];
    }

    /* What a trigger becomes, or `null` when it is not one. `Dictionary.Has` and not
     * `in`: `toString` is a word too. */
    static template(language, word) {
        return language === "js" && Dictionary.Has(SNIPPETS_JS, word) ? SNIPPETS_JS[word] : null;
    }

    /*
     * The whole word that ends at the cursor and starts where a word could:
     * `""` when the character before it is one that makes it a member or a
     * different name (`.`, `$`, a letter, a digit), and when there is no word.
     *
     * Counted in **characters**, as the editor's `Column` is: a line with an
     * emoji in it is shorter in characters than in UTF-16 units, and slicing it
     * by the latter would cut a word that is not the one the cursor is in.
     */
    static wordBefore(ed) {
        const line = ed.Text.split("\n")[ed.Line - 1];
        if (line === undefined) return "";

        const chars = Array.from(line).slice(0, ed.Column - 1);
        let start = chars.length;
        while (start > 0 && isWordChar(chars[start - 1])) start--;

        const word = chars.slice(start).join("");
        if (!word) return "";
        const before = start > 0 ? chars[start - 1] : "";
        return before === "." || before === "$" ? "" : word;
    }

    /*
     * Tab in the editor: expands the trigger before the cursor when there is
     * one and answers `true`; answers `false` -- and does nothing -- when there
     * is not, so the key is the editor's own (indent, or the next place of a
     * snippet that is already open).
     *
     * **Never in a `ReadOnly` editor.** `ReadOnly` stops the keyboard and
     * nothing else: `InsertSnippet` writes the buffer whatever the view says,
     * so a Tab after an `if` in a file that is not UTF-8 -- the one the IDE
     * opens read-only so it can never become dirty -- rewrote it.
     */
    static expand(ed) {
        if (ed.ReadOnly) return false;
        if (ed.Selection !== "") return false;

        const word     = Snippets.wordBefore(ed);
        const template = Snippets.template(ed.Language, word);
        if (template === null) return false;

        ed.Select(ed.Line, ed.Column - word.length, word.length);
        ed.InsertSnippet(template);
        return true;
    }
}
