/*
 * Folding: which blocks of a file can be closed up, and the commands that do it.
 *
 * **The runtime draws and hides; whoever knows the language says where.** The
 * editor's `FoldRanges` is a list of `{ Start, End }` lines and it puts a marker
 * beside each `Start` -- a click closes the block, and `Fold`, `Unfold`,
 * `FoldAll` and `UnfoldAll` do the same from code. Nothing in the control reads
 * a program, so a block is whatever this file says it is, which is what lets
 * `lib/` or an application with a language of its own use the same editor.
 *
 * **A block is a pair of braces or brackets that are code.** `Lex.blank` is the
 * scanner this tree already has for *is there code here*: strings, template
 * literals, regex literals and comments blanked to spaces with every line break
 * kept, so a `{` in a message or a `}` in a comment is not one, and a line
 * number read off the result is the file's own. This is a scan and not a parse,
 * as `Lex` says of itself -- it has no idea what the block *is*, and a `{` that
 * opens an object literal folds like one that opens a function. That is what an
 * editor with no parser does and it is what is wanted: both are lines a person
 * wants out of the way.
 *
 * **What a fold hides is everything after the opening line, the closer too, and
 * what is left says so.** A block from line 3 to line 9 is the range `3..9` with
 * the closer's own text as its `Tail`, and a closed one reads `foo() { … }`: the
 * editor draws the dots after the line and the `Tail` after them, as Android
 * Studio and IntelliJ do, because a margin marker alone does not say that code
 * is there. A `} else {` closer is the tail of the first block and the line the
 * second one opens on, so it is hidden with the first and back with it.
 * A block with its braces on one line (`{ }`) has nothing to hide and gets no
 * marker; two lines (`{` over `}`) fold to `{ … }`. Two blocks that open on
 * one line -- `[{` -- are one marker, for the outer.
 *
 * Only for `js`: a `.form` and a `project.json` are JSON that this editor shows
 * as a tab too, and folding them would be an answer to a question nobody asked
 * of a file the designer owns.
 */
"use strict";

export class Folding {
    /*
     * The ranges of a source text, `{ Start, End, Tail }` sorted by `Start`, `[]` for
     * text with none.
     *
     * One pass over the blanked text with a stack of openers. A closer that does
     * not match the opener on top is ignored -- an unbalanced file is a file
     * being edited, and answering for the part that is balanced is the useful
     * thing -- and an opener never closed makes no range.
     */
    static ranges(text) {
        const code  = Lex.blank(text);
        const rows  = text.split("\n");
        const stack = [];
        const best  = {};          // Start -> { End, Tail }, the outermost for that line
        let   line  = 1;

        for (let i = 0; i < code.length; i++) {
            const c = code[i];

            if (c === "\n") {
                line++;
            } else if (c === "{" || c === "[") {
                stack.push({ open: c, line });
            } else if (c === "}" || c === "]") {
                const top = stack.length ? stack[stack.length - 1] : null;
                if (!top || (c === "}") !== (top.open === "{")) continue;
                stack.pop();

                /* Everything after the opening line, down to the closer; a
                 * closer on the opening line itself is nothing to hide. */
                if (line <= top.line) continue;
                if (best[top.line] === undefined || best[top.line].End < line)
                    best[top.line] = { End: line, Tail: rows[line - 1].trim() };
            }
        }

        return Dictionary.Keys(best)
            .map((k) => ({ Start: Number(k), End: best[k].End, Tail: best[k].Tail }))
            .sort((a, b) => a.Start - b.Start);
    }

    /* Whether a file gets folding at all: see the note at the head. */
    static applies(name) {
        return !!name && File.IsExtension(name, "js");
    }

    /*
     * Brings an editor's markers up to its text. `text` is passed when the caller
     * has it already -- `Text` copies the whole buffer out of GTK -- and read
     * otherwise.
     */
    static refresh(ed, name, text) {
        ed.FoldRanges = Folding.applies(name) ? Folding.ranges(text === undefined ? ed.Text : text) : [];
    }

    /*
     * The block the cursor is in: the innermost range with the cursor between
     * its braces' lines, and **not already folded**, so the key pressed twice
     * folds the block and then the one around it, as an editor's does.
     */
    static around(ed) {
        const line  = ed.Line;
        let   found = null;

        for (const r of ed.FoldRanges) {
            if (line >= r.Start && line <= r.End && !ed.Folded(r.Start))
                found = r;      // sorted by Start: the last one is the innermost
        }
        return found;
    }

    /* The key: fold the block the cursor is in. `true` when there was one. */
    static foldHere(ed) {
        const r = Folding.around(ed);
        if (!r) return false;

        ed.Fold(r.Start);
        return true;
    }

    /* And its undo: open the fold that starts on the cursor's line. A closed
     * fold puts the cursor on its first line, so that is where it is. */
    static unfoldHere(ed) {
        return ed.Unfold(ed.Line);
    }
}
