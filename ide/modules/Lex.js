/*
 * Which parts of a file are code.
 *
 * **The question every name lookup has to ask and nobody was asking.** A scan
 * for a whole word finds it in a comment and in a string just as happily as in
 * code, and the two are lies a person reads: `// setTimeout(fn, 1) is what we
 * do not do` is not a call, and a message in a string is text. It was not
 * hypothetical -- the IDE's own check for names this language takes away
 * reported *both*, out of the very fixture written to prove it would not.
 *
 * So this is one scanner, and it is the reason two modules do not each grow
 * one. `blank()` returns the file with the *inside* of every string and comment
 * replaced by spaces: **the same length and the same line breaks**, so an index,
 * an offset and a line number found in the result are the ones in the original,
 * and a caller that already has a `Regex` over the text needs no table to line
 * its answer up. That is the whole bargain.
 *
 * **It is a scanner and not a parser**, deliberately. What a caller asks is
 * "is there code here", which a lexical answer settles; what it cannot settle
 * is what the code *means*, and the runtime's own `Application.Symbols` is the
 * parser for that. The line between the two is the one this tree keeps
 * drawing: nothing here infers a scope, resolves a name, or decides what a token
 * is for. `Ide.Navigator` refuses rather than follow a value, and this is the
 * same refusal one level down.
 *
 * Four things it has to get right, and **every one of them was wrong in the
 * first version** -- which is why each is a function with a name rather than a
 * branch inside a loop:
 *
 *   strings    `'`, `"` and backtick, with the backslash escapes inside, and a
 *              newline that ends a bad one rather than eating the file
 *   templates  a backtick's `${ ... }` is **code again**, and the hole can hold
 *              a string or a whole nested template of its own. Blanking a
 *              template whole would hide every name inside it; not recursing
 *              made the *closing* backtick look like an opening one, and the
 *              scan then ran to the end of the line eating real code
 *   regex      a `/` is a regex start or a division, and only the text before it
 *              says which -- after `( , = : [ ! & | ? { ;` and after a keyword
 *   comments   a line comment to the newline, and a block one to its closing
 *              pair across lines, and a `/` that cannot be placed is left
 *              alone -- which costs *fewer* names rather than invented ones
 *
 * The templates are why this is a small family of functions and not one loop:
 * finding the `}` that closes a hole has to skip strings, comments and nested
 * templates, which is the same knowledge `scan` has, so asking it is cheaper
 * than writing it twice. `tests/ide`'s `lex` phase is where all four are held,
 * and it is a pure function over a string -- no window, no project, no state.
 */
"use strict";

Namespace("Ide");

Ide.Lex = class Lex {

    /*
     * The file with everything that is not code blanked to spaces.
     *
     * Newlines and length are kept, and that is the promise: an offset or a
     * line number read out of the result is the one in the original.
     */
    static blank(text) {
        const out = text.split("");
        Ide.Lex.scan(text, out, 0, text.length);
        return out.join("");
    }

    /* Spaces where there is no code. A newline stays a newline, so the caller's
     * line numbers do not move. **A null `out` blanks nothing**, and that is
     * not a defensive habit: `findHoleEnd` walks a hole it is only counting
     * braces in, so it asks `template` for an index and has no array to fill. */
    static fill(out, from, to) {
        if (!out) return;
        for (let k = from; k < to; k++)
            if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
    }

    /* One pass over `[from, to)`. A template hole calls back in here, which is
     * what makes a nested template and a string inside a hole come out right. */
    static scan(text, out, from, to) {
        let i = from;

        while (i < to) {
            const c = text[i];
            const n = i + 1 < to ? text[i + 1] : "";

            if (c === "/" && n === "/") {
                let k = i;
                while (k < to && text[k] !== "\n") k++;
                Ide.Lex.fill(out, i, k);
                i = k;
                continue;
            }

            if (c === "/" && n === "*") {
                let k = i + 2;
                while (k < to && !(text[k] === "*" && text[k + 1] === "/")) k++;
                k = Math.min(k + 2, to);
                Ide.Lex.fill(out, i, k);
                i = k;
                continue;
            }

            if (c === "/" && Ide.Lex.opensRegex(out, i)) {
                const k = Ide.Lex.skipRegex(text, i, to);
                if (k > i) {                       /* it really was one */
                    Ide.Lex.fill(out, i, k);
                    i = k;
                    while (i < to && /[A-Za-z]/.test(text[i])) i++;   /* flags are code */
                    continue;
                }
                i++;
                continue;
            }

            if (c === "'" || c === '"') {
                const k = Ide.Lex.skipQuoted(text, i, to);
                Ide.Lex.fill(out, i, k);
                i = k;
                continue;
            }

            if (c === "`") {
                i = Ide.Lex.template(text, out, i, to);
                continue;
            }

            i++;
        }
    }

    /*
     * A template literal, and the index just after it.
     *
     * **The literal parts are blanked and `${` and `}` are left as they are**,
     * because they are code -- the hole between them is scanned by `scan`, so a
     * string or a whole template inside a hole is handled by the same code that
     * handles one at the top level. A `lit` cursor is what keeps the segments
     * disjoint: the literal up to a hole, then the literal after its `}`.
     */
    static template(text, out, start, to) {
        let i = start + 1;
        let lit = start;                    /* literal text starts at the backtick */

        while (i < to) {
            const c = text[i];

            if (c === "\\") { i += 2; continue; }

            if (c === "`") {
                Ide.Lex.fill(out, lit, i + 1);
                return i + 1;
            }

            if (c === "$" && text[i + 1] === "{") {
                Ide.Lex.fill(out, lit, i);           /* the literal, up to the `$` */
                const close = Ide.Lex.findHoleEnd(text, i + 2, to);
                Ide.Lex.scan(text, out, i + 2, close);
                i = close + 1;
                lit = i;                             /* the literal resumes here */
                continue;
            }

            i++;
        }

        Ide.Lex.fill(out, lit, to);          /* unterminated: take the rest */
        return to;
    }

    /*
     * The `}` that closes a hole whose `{` sits just before `from`, or `to`.
     *
     * It has to skip the same things `scan` skips, or a `}` inside a string
     * inside the hole would end it early. That is why this asks `skipQuoted`,
     * `skipRegex` and `template` rather than counting braces on its own.
     */
    static findHoleEnd(text, from, to) {
        let depth = 1;
        let i = from;

        while (i < to) {
            const c = text[i];
            const n = i + 1 < to ? text[i + 1] : "";

            if (c === "/" && n === "/") {
                let k = i;
                while (k < to && text[k] !== "\n") k++;
                i = k;
                continue;
            }
            if (c === "/" && n === "*") {
                let k = i + 2;
                while (k < to && !(text[k] === "*" && text[k + 1] === "/")) k++;
                i = Math.min(k + 2, to);
                continue;
            }
            if (c === "/" && Ide.Lex.opensRegex(text, i)) {
                const k = Ide.Lex.skipRegex(text, i, to);
                if (k > i) { i = k; while (i < to && /[A-Za-z]/.test(text[i])) i++; continue; }
                i++;
                continue;
            }
            if (c === "'" || c === '"') { i = Ide.Lex.skipQuoted(text, i, to); continue; }
            if (c === "`") { i = Ide.Lex.template(text, null, i, to); continue; }
            if (c === "{") { depth++; i++; continue; }
            if (c === "}") {
                depth--;
                if (depth === 0) return i;
                i++;
                continue;
            }
            i++;
        }
        return to;
    }

    /* Just after a `'`, `"` or backtick that starts at `i`, escapes honoured.
     * A newline ends a bad one instead of taking the rest of the file with it. */
    static skipQuoted(text, i, to) {
        const q = text[i];
        let k = i + 1;

        while (k < to) {
            if (text[k] === "\\") { k += 2; continue; }
            if (text[k] === q) return k + 1;
            if (text[k] === "\n" && q !== "`") return k;
            k++;
        }
        return to;
    }

    /* Just after a regex literal at `i`, or `i` when the `/` turned out to be
     * a division -- which is how a `Regex` a pattern cannot close is told apart
     * from one that can. */
    static skipRegex(text, i, to) {
        let k = i + 1, inClass = false;

        while (k < to) {
            const d = text[k];
            if (d === "\\") { k += 2; continue; }
            if (d === "\n") return i;              /* a division after all */
            if (d === "[") inClass = true;
            else if (d === "]") inClass = false;
            else if (d === "/" && !inClass) { k++; break; }
            k++;
        }
        return k > i ? k : i;
    }

    /*
     * Whether the `/` at `i` opens a regular expression.
     *
     * **Asked of the text already blanked** -- `out` -- and that is the point: a
     * comment or a string in front is a space by now, so it cannot be mistaken
     * for code, and a template hole's contents are still code and still count.
     * `findHoleEnd` passes the raw text because it is running where nothing has
     * been blanked yet, and the same rules hold on it.
     */
    static opensRegex(text, i) {
        let k = i - 1;
        while (k >= 0 && /[ \t]/.test(text[k])) k--;
        if (k < 0) return true;                 /* it starts the file: a regex */

        const c = text[k];
        if ("(,=:[!&|?{};+-*%~^<>".includes(c)) return true;
        if (c === "") return true;

        /* A keyword, by what is in front of the sign.  `return /x/`, and
         * `case /x/` and `of /x/`, which is why this is a list and not just
         * `return`.  **Read one character at a time rather than sliced and
         * joined**: the two callers pass different things here -- a blanked
         * array from `scan`, the raw text from `findHoleEnd` -- and indexing
         * reads a character out of either. */
        let before = "";
        for (let m = Math.max(0, k - 7); m <= k; m++) before += text[m];
        return /(^|[^A-Za-z0-9_$])(return|typeof|case|in|of|do|else|new|yield|await|delete|void)$/
            .test(before);
    }
};
