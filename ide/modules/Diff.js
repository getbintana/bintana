/*
 * A unified diff, turned into two columns that face each other.
 *
 * **Two panes showing two files are two files.** What makes them a diff is that
 * the line which changed is beside the line it replaced, and that both are
 * marked -- which is what was missing: the viewer showed the old file on the
 * left and the new one on the right, scrolled together, and after the first
 * added line the two were off by one and nothing said which lines were the
 * change.
 *
 * **The diff itself is git's**, and this class never computes one. `git diff`
 * is already fetched for the unified tab, it is what git will actually commit,
 * and it is a documented format; an LCS of its own here would be a second
 * opinion about the same two files -- and an expensive one, since the pair a
 * viewer is asked for can be four thousand lines and a table of that is
 * sixteen million cells. Git did the work. This reads the answer.
 *
 * What comes back is a row per *screen* line for each side:
 *
 *     { text, kind }      kind: "" | "Added" | "Removed" | "Gap"
 *
 * `Gap` is a line that is **not there** on this side, which is how ten added
 * lines on the right can face the place they were added on the left. Without
 * it the two columns drift apart and locked scrolling shows unrelated code --
 * and a blank line that means *nothing here* must not look like a blank line
 * that is in the file.
 *
 * Prior art for the shape: this is what Meld, `git difftool --dir-diff` and
 * every review page draw. The refusal to compute the diff is the same bargain
 * `Ide.Git` makes everywhere else: the engine is git.
 */
"use strict";

Namespace("Ide");

/* `@@ -12,7 +12,9 @@` -- the counts are optional and mean 1 when absent, which
 * is what a one-line hunk looks like. */
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

Ide.Diff = class Diff {

    /*
     * The two columns, from the two texts and the diff between them.
     *
     * `before` or `after` may be `null` -- a file the commit added has no
     * version before it -- and an empty side is the right answer for that, not
     * an error.
     *
     * **Falls back to the plain pair** when there is no diff to read: a rename
     * with no content change, a binary, a file git will not put in a diff at
     * all. Two files side by side with nothing marked is exactly what those
     * are, and it is what this viewer did for everything until now.
     */
    static sideBySide(before, after, unified) {
        const old = (before === null || before === undefined) ? [] : lines(before);
        const now = (after  === null || after  === undefined) ? [] : lines(after);
        const hunks = Diff.hunks(unified || "");

        /*
         * No diff to read. A file git has never been told about is the case
         * that matters: `git diff` says nothing about an untracked file, and
         * showing it as an unmarked wall of text would say *nothing changed
         * here* about a file that is entirely new. One side empty and the other
         * not **is** the answer, so it is drawn as one.
         */
        if (!hunks.length) {
            if (!old.length && now.length) return faced(now, "Added", true);
            if (!now.length && old.length) return faced(old, "Removed", false);
            return { left: plain(old), right: plain(now) };
        }

        const left = [], right = [];
        let bi = 0, ai = 0;                      /* 0-based, into old and now */

        for (const hunk of hunks) {
            /*
             * Everything between the last hunk and this one is unchanged, and
             * unchanged means the same number of lines on both sides -- so it
             * is copied a row at a time and the two stay level.
             */
            while (bi < hunk.from && bi < old.length && ai < now.length) {
                left.push({ text: old[bi++], kind: "" });
                right.push({ text: now[ai++], kind: "" });
            }

            /*
             * Inside a hunk, a run of `-` and the run of `+` that follows it are
             * *one* change and are paired row by row; the shorter of the two is
             * padded with gaps. Emitting all the removals and then all the
             * additions would put a line and its replacement four rows apart,
             * which is the one thing side by side is for.
             */
            let gone = [], came = [];

            const flush = () => {
                const rows = Math.max(gone.length, came.length);
                for (let i = 0; i < rows; i++) {
                    left.push(i < gone.length ? { text: gone[i], kind: "Removed" }
                                              : { text: "", kind: "Gap" });
                    right.push(i < came.length ? { text: came[i], kind: "Added" }
                                               : { text: "", kind: "Gap" });
                }
                gone = [];
                came = [];
            };

            for (const line of hunk.body) {
                const what = line[0];
                const text = line.slice(1);

                if (what === "-")      { gone.push(text); bi++; }
                else if (what === "+") { came.push(text); ai++; }
                else if (what === "\\") continue;   /* "\ No newline at end" */
                else {
                    flush();
                    left.push({ text, kind: "" });
                    right.push({ text, kind: "" });
                    bi++;
                    ai++;
                }
            }
            flush();
        }

        /* And the tail below the last hunk, which is unchanged by definition. */
        while (bi < old.length || ai < now.length) {
            left.push(bi < old.length ? { text: old[bi++], kind: "" }
                                      : { text: "", kind: "Gap" });
            right.push(ai < now.length ? { text: now[ai++], kind: "" }
                                       : { text: "", kind: "Gap" });
        }

        return { left, right };
    }

    /*
     * The hunks of a unified diff, as `{ from, to, body }` with `from` and `to`
     * **0-based**, because everything that reads them here indexes an array.
     *
     * The header lines (`diff --git`, `index`, `---`, `+++`) are skipped rather
     * than parsed: what is needed is where each hunk starts and what is in it,
     * and a diff of one file is the only shape this is ever handed.
     */
    static hunks(text) {
        const out = [];
        let hunk = null;

        /*
         * `lines` and not a bare split: a diff ends in a newline like every
         * other text, and its phantom last line would be read as one more
         * context row -- a thirteenth row under a file of twelve, with the two
         * columns still level and one line of nothing at the bottom of both.
         */
        for (const line of lines(text)) {
            const head = HUNK.exec(line);

            if (head) {
                hunk = { from: Number(head[1]) - 1, to: Number(head[3]) - 1,
                         body: [] };
                out.push(hunk);
                continue;
            }
            if (!hunk) continue;                 /* still in the preamble */

            /*
             * A hunk ends where the format stops looking like one. A context
             * line is a space and a line; an empty line in the file arrives as
             * a bare `""` from some producers, which is a context line too.
             */
            if (line === "") { hunk.body.push(" "); continue; }
            if (" -+\\".includes(line[0])) hunk.body.push(line);
            else hunk = null;
        }
        return out;
    }

    /*
     * The marks for one column, applied to an editor.
     *
     * One pass, and `ClearMarks` first: the panes are reused for every file
     * chosen, and marks left from the last one would be a diff of two files
     * neither of which is on screen.
     */
    static mark(editor, rows) {
        editor.ClearMarks();

        for (let i = 0; i < rows.length; i++)
            if (rows[i].kind) editor.Mark(i + 1, rows[i].kind);
    }

    /* The text of one column, which is what the editor is given. */
    static text(rows) {
        return rows.map((r) => r.text).join("\n");
    }
};

/*
 * A text as its lines, without the empty one a trailing newline leaves behind.
 *
 * Every file git hands back ends in a newline, and `"a\nb\n".split("\n")` is
 * three things -- so without this every pane has a phantom last line, and the
 * one on the right would be marked as a gap against it.
 */
function lines(text) {
    const all = text.split("\n");
    if (all.length && all[all.length - 1] === "") all.pop();
    return all;
}

function plain(all) {
    return all.map((text) => ({ text, kind: "" }));
}

/* A whole file on one side and nothing on the other: every line marked, and a
 * gap facing each of them so the two columns are still the same height. */
function faced(all, kind, onRight) {
    const there = all.map((text) => ({ text, kind }));
    const empty = all.map(() => ({ text: "", kind: "Gap" }));

    return onRight ? { left: empty, right: there }
                   : { left: there, right: empty };
}
