/*
 * A Markdown document, as a component.
 *
 * `Markdown` is to a document what [`Report`](../report/Report.js) is to a
 * printed one, and it is built the same way: a **measure** pass turns the source
 * into a flat list of display items with an absolute `Y`, and a **draw** pass
 * paints the ones the viewport is standing over. It is reached the way any
 * library is (`uses: ["markdown"]`), declared in a `.form` like any control, and
 * it draws with the same `Painter` every other drawing here uses.
 *
 * **What it publishes is documented like the runtime's own surface**, in
 * [docs/llm/markdown.md](../../docs/llm/markdown.md), and `tests/api.sh` fails
 * when a property here has no row there: a library that ships with the runtime
 * is part of the contract.
 *
 * ## Why it is drawn and not built out of controls
 *
 * A document made of `Label`s is a container with four thousand widgets in it,
 * and the interesting questions -- where the page breaks, where a heading sits,
 * what the whole thing is as a PDF -- all become questions about a layout
 * nobody can see. Drawing it makes the layout a list this file owns: that is
 * what makes `ContentHeight` answerable before a frame, `Headings` a list of
 * positions a table of contents can jump to, and the export the same pass as
 * the screen.
 *
 * ## The two things the runtime had to learn
 *
 * A paragraph of Markdown is a *flow of runs* -- a word in bold, a name in
 * italic, a code span in a monospace -- that wraps. `Text.Lines` breaks one
 * string in one font and cannot break a line where the font changes halfway, so
 * before this the only way to draw one was to measure word by word and pack the
 * lines by hand: a Pango layout per word, and wrong for every script that does
 * not put spaces between them.
 *
 * So the text surface learned what `Label` has had all along: **markup**.
 * `Text.Size(markup, font, { Width, Markup: true })` measures a styled paragraph
 * and `Painter.Text(markup, x, y, { Width, Markup: true })` draws it -- one
 * call, one layout, broken by the same Pango both times, which is the rule every
 * measurement here follows. `Text.Escape` is the other half: the `<` somebody
 * wrote in a document and the `<` that opens a tag are the same character, and
 * one call apart.
 *
 * The second is **where a character is**. A document made of controls would get
 * a selection from the toolkit; a drawn one has to ask the layout it drew with,
 * because where the lines broke, which run is in which font and which way the
 * text runs are all the layout's, and none of that survives being handed back
 * as strings. `Text.IndexAt` turns a pointer into an offset and `Text.Bounds`
 * turns a pair of offsets back into the rectangles to paint behind the words --
 * which is the whole of the selection here, and the reason what is kept is
 * offsets and not rectangles: the words survive a resize and the rectangles do
 * not.
 *
 * ## What it does not do
 *
 * These are decisions, written down rather than discovered:
 *
 * - **A link is an address and not an action.** What opens `https://...` or
 *   `../other.md` is the application's decision, so a click raises `Link` and
 *   this component does nothing -- except for a `#anchor` nobody claimed, which
 *   is the one address it can honour on its own. Reference links (`[a][b]`) are
 *   not read at all.
 * - **No syntax highlighting in a code block**, and settled rather than pending:
 *   it is a `SourceEditor` that knows how to colour code, a viewer that shipped
 *   half a highlighter would be wrong in a different language every week, and a
 *   document is read for its prose.
 * - **A selection, but no caret and no search.** Drag, double click, Ctrl+A,
 *   Ctrl+C; a drag that leaves the view does not scroll it.
 * - **An inline image is its alt text.** Pango markup has no picture in it, so a
 *   picture is a block: a paragraph that holds nothing but an image is drawn as
 *   one, and an image in the middle of a sentence reads as the words in its
 *   brackets.
 * - **A missing image is a box with its alt text in it and not a throw**, which
 *   is where this parts company with `Report`: a masthead that is missing is a
 *   report that must not print, and a broken image in somebody's notes is
 *   Tuesday.
 * - **CommonMark, and a useful subset of it.** What is in is listed in
 *   `docs/llm/markdown.md`; reference links, HTML blocks, footnotes and nested
 *   emphasis edge cases are not.
 */
"use strict";

/* The ink a document is drawn in, light ground and dark. A viewer is not a
 * printed page -- it sits in the application's own window and follows its theme
 * -- so unlike `Report` these are two palettes and not one. `Painter.Dark`
 * chooses, and the measure is redone when the answer changes, because the
 * markup carries the colours of the theme it was built for. */
const LIGHT = {
    Ground: "#ffffff",     /* only an export paints it: see `Canvas_Draw` */
    Ink:    "#1a1a1a",
    Dim:    "#5c5c5c",     /* a quote, a caption, a table rule */
    Link:   "#1c71d8",
    Code:   "#a33d7a",     /* a code span's letters */
    Panel:  "#f2f1f0",     /* a code block's ground */
    Rule:   "rgba(0,0,0,0.15)",
    Select: "rgba(53,132,228,0.28)",
};

const DARK = {
    Ground: "#1e1e1e",
    Ink:    "#f6f5f4",
    Dim:    "#b5b1ad",
    Link:   "#78aeed",
    Code:   "#f4a8d0",
    Panel:  "rgba(255,255,255,0.06)",
    Rule:   "rgba(255,255,255,0.18)",
    Select: "rgba(120,174,237,0.32)",
};

/* How much bigger than the body a heading is, by level. The sixth is smaller
 * than the text it heads, which is what every stylesheet since the first one
 * does with an h6. */
const HEADINGS = [2.0, 1.6, 1.3, 1.15, 1.0, 0.9];

/* Spacing, in multiples of the body's line height -- so a document set in a
 * larger font is spaced in proportion rather than in pixels that stopped
 * meaning anything. */
const GAP        = 0.55;    /* between blocks */
const HEAD_ABOVE = 1.1;     /* extra room over a heading: a section starts here */
const INDENT     = 1.6;     /* one list level, and a quote's step */
const PAD        = 0.5;     /* inside a code block and a table cell */

/* The bullets, by depth. Three, then it starts again -- a list nested deeper
 * than that has a shape problem no glyph is going to fix. */
const BULLETS = ["•", "◦", "▪"];

/* ------------------------------------------------------------------ parsing
 *
 * Line-based, which is what Markdown is: the block structure is decided by what
 * a line *starts with*, and only what is left over -- the runs inside a
 * paragraph -- needs a character scanner. The two halves are `blocks()` below
 * and `inline()` further down, and they never call each other's work twice: a
 * block holds the markup its inline pass produced, once, and the measure never
 * parses anything.
 */

const RE_FENCE  = /^ {0,3}(```+|~~~+)\s*([^`]*)$/;
const RE_ATX    = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*$/;
const RE_RULE   = /^ {0,3}((?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const RE_QUOTE  = /^ {0,3}>\s?(.*)$/;
const RE_BULLET = /^(\s*)([-*+])(\s+)(.*)$/;
const RE_NUMBER = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/;
const RE_SETEXT = /^ {0,3}(=+|-+)\s*$/;
const RE_DELIM  = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/*
 * The source as a list of blocks.
 *
 * Recursive in exactly two places -- a quote's contents and a list item's --
 * and both times by handing the *dedented* lines back to this function, which
 * is what makes `> - a` a quote holding a list rather than a special case.
 */
function blocks(lines) {
    const out = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) { i++; continue; }

        /* A fence first: everything inside one is text, including the lines
         * that would otherwise be a heading or a rule. */
        const fence = RE_FENCE.exec(line);
        if (fence) {
            const mark = fence[1][0];
            const body = [];
            i++;
            while (i < lines.length && !closes(lines[i], mark))
                body.push(lines[i++]);
            i++;                                   /* the closing fence, if any */
            out.push({ Kind: "Code", Text: body.join("\n"),
                       Language: (fence[2] || "").trim() });
            continue;
        }

        if (RE_RULE.test(line)) { out.push({ Kind: "Rule" }); i++; continue; }

        const atx = RE_ATX.exec(line);
        if (atx) {
            out.push(heading(atx[1].length, (atx[2] || "").replace(/\s+#+\s*$/, "")));
            i++;
            continue;
        }

        if (RE_QUOTE.test(line)) {
            const body = [];
            /* A quote swallows its lazy continuations: a line with no `>` that
             * carries on the paragraph belongs to the quote, and a blank one
             * ends it. */
            while (i < lines.length && lines[i].trim() &&
                   (RE_QUOTE.test(lines[i]) || !starts(lines[i]))) {
                const m = RE_QUOTE.exec(lines[i]);
                body.push(m ? m[1] : lines[i]);
                i++;
            }
            out.push({ Kind: "Quote", Blocks: blocks(body) });
            continue;
        }

        if (RE_BULLET.test(line) || RE_NUMBER.test(line)) {
            const list = takeList(lines, i);
            out.push(list.block);
            i = list.next;
            continue;
        }

        /* A table is two lines at once: a row, and under it the delimiter that
         * says how many columns there are and how each is aligned. Without the
         * second line it is an ordinary paragraph that happens to have pipes in
         * it, which is what a shell command in prose looks like. */
        if (line.includes("|") && i + 1 < lines.length && RE_DELIM.test(lines[i + 1]) &&
            cells(lines[i]).length > 1) {
            const table = takeTable(lines, i);
            out.push(table.block);
            i = table.next;
            continue;
        }

        /* Four spaces of indent is a code block, but only where a paragraph is
         * not already running -- inside one it is a continuation line, which is
         * how most people write a wrapped sentence. */
        if (/^ {4}/.test(line)) {
            const body = [];
            while (i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim())) {
                if (!lines[i].trim() && !nextIndented(lines, i)) break;
                body.push(lines[i].slice(4));
                i++;
            }
            out.push({ Kind: "Code", Text: body.join("\n").replace(/\s+$/, ""), Language: "" });
            continue;
        }

        /* What is left is a paragraph, and it runs until a blank line or until
         * a line that starts something else. */
        const text = [];
        while (i < lines.length && lines[i].trim() &&
               !(text.length && (starts(lines[i]) || RE_SETEXT.test(lines[i])))) {
            text.push(lines[i]);
            i++;
        }

        /* Setext: the paragraph was a heading all along, and only its next line
         * says so. One line of it, which is the case anybody actually writes. */
        if (i < lines.length && text.length === 1 && RE_SETEXT.test(lines[i])) {
            out.push(heading(lines[i].trim()[0] === "=" ? 1 : 2, text[0].trim()));
            i++;
            continue;
        }
        /* A paragraph that is nothing but a picture is a picture, and it is
         * decided here rather than on every measure: the question is about the
         * source and the source does not change under a resize. */
        const body = text.join("\n");
        const pic  = imageOnly(body);

        out.push(pic ? { Kind: "Image", Alt: pic.Alt, File: pic.File }
                     : { Kind: "Paragraph", Text: body });
    }
    return out;
}

/* Whether a line opens a block of its own -- which is what tells a paragraph
 * where to stop and a lazy quote line where it does not. */
/* The fence that closes the one that opened with this character -- three or
 * more of it, and nothing else on the line. */
function closes(line, mark) {
    const m = /^ {0,3}(```+|~~~+)\s*$/.exec(line);
    return !!m && m[1][0] === mark;
}

function starts(line) {
    return RE_FENCE.test(line) || RE_ATX.test(line) || RE_RULE.test(line) ||
           RE_QUOTE.test(line) || RE_BULLET.test(line) || RE_NUMBER.test(line);
}

/* A blank line inside an indented code block is still inside it when indented
 * code follows; otherwise the block ended and the blank belongs to nobody. */
function nextIndented(lines, i) {
    for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        return /^ {4}/.test(lines[j]);
    }
    return false;
}

function heading(level, text) {
    const plain = strip(text);
    return { Kind: "Heading", Level: level, Text: text, Plain: plain, Id: slug(plain) };
}

/* The anchor a table of contents jumps to: what GitHub makes of a heading,
 * near enough -- lowercased, punctuation dropped, spaces hyphenated. */
function slug(text) {
    return text.toLowerCase().trim()
               .replace(/[^\w\s-]/g, "")
               .replace(/\s+/g, "-");
}

/* The words of a heading without its emphasis, which is what a contents list
 * shows and what `ScrollTo` matches on. */
function strip(text) {
    return text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
               .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
               .replace(/[*_`~]/g, "")
               .trim();
}

/*
 * One list, from the line that opens it to the first line that is not part of
 * it.
 *
 * **An item is its first line plus everything indented under it**, and that
 * indented remainder goes back through `blocks()` -- so a paragraph, a nested
 * list, a quote or a fenced block inside an item all work without this function
 * knowing what any of them are.
 */
function takeList(lines, from) {
    const first   = RE_NUMBER.exec(lines[from]) || RE_BULLET.exec(lines[from]);
    const ordered = !!RE_NUMBER.exec(lines[from]);
    const start   = ordered ? Number(first[2]) : 1;
    const base    = first[1].length;

    const items = [];
    let   i     = from;
    let   tight = true;
    let   blank = false;

    while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) { blank = true; i++; continue; }

        const bullet = RE_BULLET.exec(line);
        const number = RE_NUMBER.exec(line);
        const marker = number || bullet;

        /* A marker at this list's own indent opens the next item. One further
         * in belongs to the item that is open, and is picked up below as part
         * of its body. */
        if (marker && marker[1].length <= base + 1) {
            if (!!number !== ordered && items.length) break;
            if (blank && items.length) tight = false;
            blank = false;

            const width = marker[1].length +
                          (number ? number[2].length + 1 + number[4].length
                                  : 1 + bullet[3].length);
            const body  = [number ? number[5] : bullet[4]];
            i++;

            /* The rest of the item: anything indented past the marker, and a
             * lazy continuation line that starts nothing of its own. */
            while (i < lines.length) {
                if (!lines[i].trim()) {
                    if (!continues(lines, i, width)) break;
                    body.push("");
                    i++;
                    blank = true;
                    continue;
                }
                const indent = lines[i].length - lines[i].replace(/^\s*/, "").length;
                if (indent >= Math.min(width, base + 2)) {
                    body.push(lines[i].slice(Math.min(width, indent)));
                    i++;
                    continue;
                }
                if (!starts(lines[i]) && !blank) { body.push(lines[i]); i++; continue; }
                break;
            }
            if (blank && i < lines.length && lines[i].trim() &&
                (RE_BULLET.test(lines[i]) || RE_NUMBER.test(lines[i]))) tight = false;

            items.push(blocks(body));
            continue;
        }
        break;
    }
    return { block: { Kind: "List", Ordered: ordered, Start: start,
                      Tight: tight, Items: items },
             next: i };
}

/* Whether a blank line is inside an item still -- it is when something
 * indented under the item follows it. */
function continues(lines, i, width) {
    for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].trim()) continue;
        const indent = lines[j].length - lines[j].replace(/^\s*/, "").length;
        return indent >= Math.min(width, 2);
    }
    return false;
}

/* The cells of one table row. A trailing or leading pipe is decoration and an
 * escaped one is a pipe. */
function cells(line) {
    const out = [];
    let cell  = "";

    for (let i = 0; i < line.length; i++) {
        if (line[i] === "\\" && line[i + 1] === "|") { cell += "|"; i++; continue; }
        if (line[i] === "|") { out.push(cell); cell = ""; continue; }
        cell += line[i];
    }
    out.push(cell);

    if (out.length && !out[0].trim()) out.shift();
    if (out.length && !out[out.length - 1].trim()) out.pop();
    return out.map((c) => c.trim());
}

function takeTable(lines, from) {
    const head  = cells(lines[from]);
    const align = cells(lines[from + 1]).map((c) => {
        const left  = c.startsWith(":");
        const right = c.endsWith(":");
        return right && left ? "Center" : right ? "Right" : "Left";
    });

    const rows = [];
    let   i    = from + 2;

    while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const row = cells(lines[i]);
        /* A short row is padded and a long one is cut: the header decides how
         * many columns there are, which is what a table means by a column. */
        while (row.length < head.length) row.push("");
        rows.push(row.slice(0, head.length));
        i++;
    }
    return { block: { Kind: "Table", Head: head, Align: align, Rows: rows }, next: i };
}

/* ------------------------------------------------------------------- inline
 *
 * The runs inside a paragraph, as **Pango markup**: one string that carries its
 * own bold, italic, monospace and colour, which is what lets the whole
 * paragraph be measured and drawn in one call and broken into lines by the same
 * Pango both times. Everything that is not a run goes through `Text.Escape`, so
 * a `<` somebody wrote is a `<` and never half a tag.
 */

/* What a backslash may hide, which is the punctuation Markdown itself uses. */
const PUNCT = "\\`*_{}[]()#+-.!|~<>&\"'";

function inline(text, ink) {
    let out   = "";        /* the markup */
    let plain = "";        /* and what Pango will lay it out as */
    let buf   = "";        /* ordinary characters, not yet escaped */
    let i     = 0;

    /* Where the links are, as ranges in `plain` -- which is what turns a click
     * back into an address. They are collected **here**, while the markup is
     * being built, for the same reason the plain text is: this is the only pass
     * that knows both what a run says and where it landed. */
    const links = [];

    /* **The ordinary text is escaped in runs and not a character at a time.**
     * `Text.Escape` is a call into C; a 72 KB document has 72 000 characters
     * that are not markup in it, and escaping each one was most of what parsing
     * such a document cost -- measured, 139 ms against 71 for the parse and 732
     * against 348 for the first measure. Everything below that is *not* a run
     * appends to `buf`, and the next thing that is flushes it, once.
     *
     * **The two strings are built in the same pass and that is not tidiness.**
     * A selection is a pair of offsets into the text Pango laid out, so the
     * plain text a caller slices has to be exactly the text the layout holds --
     * character for character. Recovering it afterwards by stripping tags would
     * be a second opinion about what the markup says, and the two would agree
     * until the day a document had a `&amp;` in it. */
    const flush = () => {
        if (!buf) return;
        out   += Text.Escape(buf);
        plain += buf;
        buf    = "";
    };

    /* A run that carries its own tags: the markup is wrapped, the plain text is
     * not. `href` makes the run a link; an inner run's links are carried out
     * with it, shifted to where its text landed, so `*[a](b)*` is still a link.
     */
    const run = (open, inner, close, href) => {
        flush();

        const at = plain.length;

        out   += open + inner.Markup + close;
        plain += inner.Plain;

        for (const link of inner.Links || [])
            links.push({ From: at + link.From, To: at + link.To, Href: link.Href });
        if (href)
            links.push({ From: at, To: plain.length, Href: href });
    };

    while (i < text.length) {
        const ch = text[i];

        if (ch === "\\" && i + 1 < text.length && PUNCT.includes(text[i + 1])) {
            buf += text[i + 1];
            i += 2;
            continue;
        }

        if (ch === "`") {
            const length = runLength(text, i, "`");
            const mark   = text.slice(i, i + length);
            const end    = text.indexOf(mark, i + length);

            if (end >= 0) {
                /* A code span keeps its spaces and loses one at each end, which
                 * is how `` ` `` is written as a code span at all. */
                const code = text.slice(i + length, end).replace(/^ (.*) $/, "$1");

                run(`<span font_family="${ink.CodeFamily}" foreground="${ink.Code}">`,
                    { Markup: Text.Escape(code), Plain: code }, "</span>");
                i = end + length;
                continue;
            }
        }

        /* A picture in the middle of a sentence: Pango markup has no image in
         * it, so what the reader gets is the words in the brackets. A paragraph
         * that is *only* a picture never reaches here -- see `imageOnly`. */
        if (ch === "!" && text[i + 1] === "[") {
            const link = takeLink(text, i + 1);
            if (link) {
                run("<i>", inline(link.text, ink), "</i>");
                i = link.next;
                continue;
            }
        }

        if (ch === "[") {
            const link = takeLink(text, i);
            if (link) {
                run(`<span foreground="${ink.Link}" underline="single">`,
                    inline(link.text, ink), "</span>", link.href);
                i = link.next;
                continue;
            }
        }

        /* An autolink: `<https://…>` and `<someone@somewhere>`, which are the
         * two shapes that are a link without being written as one. */
        if (ch === "<") {
            const close = text.indexOf(">", i);
            const body  = close > 0 ? text.slice(i + 1, close) : "";
            if (body && (/^([a-z][a-z0-9+.-]*:\/\/|mailto:)\S+$/i.test(body) ||
                         /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body))) {
                run(`<span foreground="${ink.Link}" underline="single">`,
                    { Markup: Text.Escape(body), Plain: body }, "</span>", body);
                i = close + 1;
                continue;
            }
        }

        if (ch === "*" || ch === "_" || ch === "~") {
            const length = runLength(text, i, ch);

            /* `snake_case` is one word and not an emphasis: an underscore only
             * opens one at the edge of a word, which is the rule that keeps
             * identifiers out of italics. An asterisk has no such rule, because
             * nobody writes `a*b` and means multiplication in prose. */
            const boundary = ch !== "_" || (i === 0 || !/[\w]/.test(text[i - 1]));

            if (boundary && text[i + length] && !/\s/.test(text[i + length])) {
                const want  = ch.repeat(Math.min(length, 2));
                const close = findClose(text, i + length, want, ch);

                if (close >= 0) {
                    const tag = ch === "~" ? "s" : want.length === 2 ? "b" : "i";

                    run(`<${tag}>`, inline(text.slice(i + want.length, close), ink),
                        `</${tag}>`);
                    i = close + want.length;
                    continue;
                }
            }
        }

        /* A line ending in two spaces is a hard break and is the one newline a
         * paragraph keeps; every other newline is a space, because a sentence
         * wrapped in the source is one sentence. The spaces that said so are
         * **dropped here rather than swept up at the end**: a pass over the
         * finished markup would take them out of one string and not the other,
         * and the two must not drift by a character. */
        if (ch === "\n") {
            const hard = / {2,}$/.test(buf);

            buf = buf.replace(/ +$/, "");
            flush();

            out   += hard ? "\n" : " ";
            plain += hard ? "\n" : " ";
            i++;
            while (i < text.length && text[i] === " ") i++;
            continue;
        }

        buf += ch;
        i++;
    }
    flush();
    return { Markup: out, Plain: plain, Links: links };
}

function runLength(text, at, ch) {
    let n = 0;
    while (text[at + n] === ch) n++;
    return n;
}

/* The closing delimiter of the same length, skipping what is escaped and what
 * is inside a code span -- a `*` in `` `a*b` `` closes nothing. */
function findClose(text, from, want, ch) {
    for (let i = from; i < text.length; i++) {
        if (text[i] === "\\") { i++; continue; }
        if (text[i] === "`") {
            const run = runLength(text, i, "`");
            const end = text.indexOf("`".repeat(run), i + run);
            if (end < 0) return -1;
            i = end + run - 1;
            continue;
        }
        if (text[i] !== ch) continue;

        const run = runLength(text, i, ch);
        if (run < want.length || /\s/.test(text[i - 1] || " ")) { i += run - 1; continue; }
        return i;
    }
    return -1;
}

/* `[text](href)` from the bracket, with the nesting a link's own text may have
 * (`[a **b** c](x)`), or nothing -- in which case the bracket is a bracket. */
function takeLink(text, at) {
    let depth = 0, i = at;

    for (; i < text.length; i++) {
        if (text[i] === "\\") { i++; continue; }
        if (text[i] === "[") depth++;
        else if (text[i] === "]") { depth--; if (!depth) break; }
    }
    if (depth || text[i + 1] !== "(") return null;

    const close = text.indexOf(")", i + 2);
    if (close < 0) return null;

    const target = text.slice(i + 2, close).trim();
    /* A title in quotes is part of the target and not part of the address. */
    const href   = target.replace(/\s+["'(].*$/, "");

    return { text: text.slice(at + 1, i), href, next: close + 1 };
}

/*
 * The widest word in a cell, measured on the words themselves rather than on the
 * markup -- a column cannot be narrower than this without hyphenating somebody's
 * heading, which is what `Headin-gs` in a table looks like.
 *
 * **A word inside backticks is measured in the code font**, which is the one
 * that matters: a monospace is wider than the body face, so a column of member
 * names -- every reference page in this tree is one -- was given a floor it did
 * not fit in, and `Background` came out as `Backgrou-nd`. The odd segments of a
 * split on the backtick are the code spans, which is exact for the case that
 * breaks and costs a `split`.
 */
function longest(text, font, code) {
    let widest = 0;

    /* Not `String(text).split(...)` on this line: `tests/api` reads a library's
     * surface out of the source, and a line that starts with a capitalised call
     * at a method's indentation reads exactly like a method being declared. */
    const parts = String(text).split("`");

    parts.forEach((part, at) => {
        const face = (at % 2) ? code : font;

        for (const word of strip(part).split(/\s+/))
            if (word) widest = Math.max(widest, Text.Width(word, face));
    });
    return widest;
}

/* A paragraph that is nothing but a picture -- `![alt](file.png)` on a line of
 * its own -- which is the one an author means to be a picture. */
function imageOnly(text) {
    const m = /^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+["'(][^)]*)?\s*\)$/.exec(text.trim());
    return m ? { Alt: m[1], File: m[2] } : null;
}

/* ------------------------------------------------------------------- fonts
 *
 * Every font in a document is the body font in some proportion, so what is
 * declared is one description and the rest is arithmetic: a heading is the body
 * scaled and emboldened, a code block is the monospace at the body's size. A
 * document set in a larger font is *entirely* larger, which is what a reader
 * who turned the desktop's text scale up is asking for.
 */
function faceOf(spec, fallback) {
    const said = (spec || "").trim() || fallback || "Sans 11";
    const m    = /^(.*?)\s+(\d+(?:\.\d+)?)$/.exec(said);

    return m ? { Name: m[1].trim(), Size: Number(m[2]) }
             : { Name: said, Size: 11 };
}

function sized(face, scale, bold) {
    const size = Math.max(4, Math.round(face.Size * scale * 10) / 10);
    return `${face.Name}${bold ? " Bold" : ""} ${size}`;
}

/*
 * **This library declares no paper table.** It had one, and so did
 * `lib/report` -- the same three sizes, written out identically -- and two
 * top-level `const PAPERS` in one global scope is a project that names both of
 * them failing to start at all: `SyntaxError: redeclaration of 'PAPERS'`, on
 * line 1 of a file its author never wrote. The libraries share the project's
 * global scope, so a name declared here is a name no other library may use.
 *
 * `Printer.Papers` is the one table, read off GTK rather than written out a
 * third time, and it is asked for where it is needed: 3.7 us a lookup,
 * measured, against nine lookups that all happen when a property is assigned
 * or a document is exported.
 */

class Markdown extends Component {

    static Events  = ["Scroll", "Select", "Link"];
    static Options = { Paper: ["A4", "Letter", "A5"] };

    /* ---------------------------------------------------------------- fields
     *
     * **Declared, and that is the whole of what this block is for.** A
     * component is a control, and under `--strict` a control stops being
     * extensible the moment it is built (`docs/strict-plan.md`), so a field
     * this class only creates when something first *happens* to it -- the
     * measure's `_items`, the pointer's `_cursor`, `Load`'s `_path` -- is an
     * attempt to add a name to a sealed object, and throws on the first frame
     * the viewer draws. Here they exist before the seal, because a class body
     * runs with the constructor.
     *
     * **Without values**, which is the one decision in it: what a field means
     * while it is unset is already written in the getter that reads it
     * (`this._text || ""`, `this._max === undefined ? 0 : this._max`), and a
     * default said in two places is a default that will disagree with itself.
     * This says the field is the class's; it does not say what it holds.
     */

    /* What the properties keep. */
    _text; _blocks; _path; _base; _code; _max; _margins; _paper; _top;
    _needle; _sel;

    /* What the measure leaves behind, dropped by `remeasure()`. */
    _items; _headings; _height; _lh; _measured; _sizes; _thumb;

    /* The pointer, between a press and the release that ends it. */
    _anchor; _picking; _drag; _cursor;

    /* Where the sheets cut, while a paginated export or print is running:
     * what `Canvas_DrawPage` looks a page number up in. `null` otherwise. */
    _sheets;

    /* Set only while an export is drawing: which slice of the document this
     * frame is, and where. `null` every other moment. */
    _paint;

    /* ------------------------------------------------------------ properties
     *
     * Ordinary accessors, which is what makes them designable and serialisable.
     * Every one that changes the layout drops the measure rather than redoing
     * it: the next frame -- or the next question about the document -- measures
     * once, so six properties assigned in a row cost one pass and not six.
     */

    /* The document, as Markdown.
     *
     * **Not a translated property**, and that is the same line `SourceEditor`
     * draws: a catalogue collects what a form *declares*, and a whole document
     * in a `.po` file is not a caption somebody will translate -- it is the
     * text the application was given to show. */
    get Text() { return this._text || ""; }
    set Text(v) {
        this._text  = v === undefined || v === null ? "" : String(v);
        this._blocks = blocks(this._text.replace(/\r\n?/g, "\n").split("\n"));
        this._top    = 0;
        this._sel    = null;
        this._needle = "";
        this.remeasure();
    }

    /* Where the document came from, which is what a relative image resolves
     * against. Setting `Text` by hand leaves it empty and images then resolve
     * against the project, as they do everywhere else here. */
    get Path() { return this._path || ""; }
    set Path(v) { this._path = v === undefined || v === null ? "" : String(v); this.remeasure(); }

    /* The body font; everything else is this in some proportion -- see `faceOf`.
     * `""` is the desktop's, which is what a document should be set in unless
     * somebody said otherwise. */
    get BaseFont() { return this._base || ""; }
    set BaseFont(v) { this._base = String(v || ""); this.remeasure(); }

    /* What a code span and a code block are set in. `""` is the desktop's
     * monospace at the body's size. */
    get CodeFont() { return this._code || ""; }
    set CodeFont(v) { this._code = String(v || ""); this.remeasure(); }

    /* The measure of the text column, in pixels. `0` is the whole width; past
     * that the column keeps this width and is **centred**, which is what makes
     * a maximised window readable instead of a single line of ninety words. */
    get MaxWidth() { return this._max === undefined ? 0 : this._max; }
    set MaxWidth(v) {
        const n = Math.max(0, Math.round(Number(v) || 0));
        if (n === this._max) return;
        this._max = n;
        this.remeasure();
    }

    /* The gutter around the document, in pixels: one number for all four edges,
     * or `{ Top, Right, Bottom, Left }`. */
    get Margins() { return this._margins === undefined ? 24 : this._margins; }
    set Margins(v) {
        if (typeof v === "number" && isFinite(v)) { this._margins = v; this.remeasure(); return; }
        if (v && typeof v === "object" && !Array.isArray(v)) {
            this._margins = {
                Top:    Number(v.Top    === undefined ? 24 : v.Top),
                Right:  Number(v.Right  === undefined ? 24 : v.Right),
                Bottom: Number(v.Bottom === undefined ? 24 : v.Bottom),
                Left:   Number(v.Left   === undefined ? 24 : v.Left),
            };
            this.remeasure();
            return;
        }
        throw new Error("Margins expects a number or { Top, Right, Bottom, Left }");
    }

    /* The paper `SavePdf` uses when it is not told one. */
    get Paper() { return this._paper || "A4"; }
    set Paper(v) {
        if (!Printer.Papers[String(v)])
            throw new Error(`Paper: '${v}' is not one of ${Dictionary.Keys(Printer.Papers).join(", ")}`);
        this._paper = String(v);
    }

    /* How far down the document is scrolled, in pixels. Assigning **clamps** to
     * `[0, ScrollMax]`, so a number past the end is the end -- the same bargain
     * `Scroller.ScrollY` makes, and for the same reason: a viewer that can be
     * scrolled into blank space below its own text is a bug nobody can see. */
    get Scroll() { return this._top || 0; }
    set Scroll(v) {
        const n = Math.max(0, Math.min(this.ScrollMax, Math.round(Number(v) || 0)));
        if (n === (this._top || 0)) return;
        this._top = n;
        this.redraw();
        this.Emit("Scroll", n);
    }

    get ScrollMax() { return Math.max(0, this.ContentHeight - this.viewHeight()); }

    /* How tall the whole document is, measured. Answerable before a frame --
     * lazily, against the width the component has been given so far -- which is
     * what `PageCount` is to a report. */
    get ContentHeight() { this.ensure(); return this._height || 0; }

    /* Every heading, in the order they appear: `{ Level, Text, Id, Y }`. What a
     * table of contents is built from, and what `ScrollTo` looks in. */
    get Headings() { this.ensure(); return this._headings || []; }

    /*
     * What the reader has selected, as text.
     *
     * A selection is a pair of *offsets into runs of text* -- the Nth run and
     * the character in it -- and not a pair of points, which is what lets it
     * survive a resize: the words are the same, the rectangles are not. The
     * runs are joined with a newline, so selecting across three paragraphs and
     * pasting gives three paragraphs. A list's bullets and a table's rules are
     * not runs of text and do not come out, exactly as they would not on a web
     * page.
     */
    get Selection() {
        const range = this.range();
        if (!range) return "";

        const parts = [];
        for (const it of this._items || []) {
            if (it.Key === undefined || it.Key < range.From.Key || it.Key > range.To.Key)
                continue;

            const text = it.Plain === undefined ? "" : it.Plain;
            const from = it.Key === range.From.Key ? range.From.At : 0;
            const to   = it.Key === range.To.Key   ? range.To.At   : text.length;

            parts.push(text.slice(from, to));
        }
        return parts.join("\n");
    }

    /* ---------------------------------------------------------------- verbs */

    /* The file, into `Text`, remembering where it came from so its pictures
     * resolve. */
    Load(path) {
        this._path = String(path);
        this.Text  = File.Load(this._path);
    }

    /* Measure again and repaint. Nothing here needs it -- every property does
     * it already -- but a document whose *pictures* changed on disk does, and
     * so does a host that changed the desktop's font. */
    Refresh() {
        this._sizes = null;          /* the pictures again: that is what this is for */
        this.remeasure();
        this.ensure();
    }

    /* Put a heading at the top of the view. Takes the `Id` a heading carries,
     * or the words themselves -- because the caller that has a list of headings
     * has both, and the one that typed a link has neither. */
    ScrollTo(id) {
        const want = String(id).replace(/^#/, "");
        const hit  = this.Headings.find((h) => h.Id === want) ||
                     this.Headings.find((h) => h.Id === slug(want)) ||
                     this.Headings.find((h) => h.Text === want);

        if (!hit) return false;
        this.Scroll = Math.max(0, hit.Y - this.margins().Top);
        return true;
    }

    /* Every word in the document, which is what Ctrl+A does. */
    SelectAll() {
        const runs = (this.laid() || []).filter((it) => it.Key !== undefined);
        if (!runs.length) return false;

        const last = runs[runs.length - 1];
        this.select({ Key: runs[0].Key, At: 0 },
                    { Key: last.Key, At: (last.Plain || "").length });
        return true;
    }

    /* Nothing selected. Answers whether there had been something, so a host can
     * tell a cleared selection from a click on a document with none. */
    Deselect() {
        if (!this._sel) return false;
        this.select(null, null);
        return true;
    }

    /* The selection onto the clipboard, which is what Ctrl+C does -- published
     * because a *Copy* button and a context menu want the same verb, and
     * because `Clipboard.Copy(this.Doc.Selection)` in a host is the same two
     * lines written again. Answers whether there was anything to copy. */
    Copy() {
        const text = this.Selection;
        if (!text) return false;

        Clipboard.Copy(text);
        return true;
    }

    /*
     * Find a run of text, select it and bring it on screen.
     *
     * The document's own search, and the reason it exists is the IDE: a page of
     * this reference is opened *at* a member -- F1 on a property lands on the row
     * that describes it -- and an anchor is no use for that, since the finest one
     * a heading gives is the class. What is being asked for is *put this text in
     * front of me*, which is a search with a selection on the end of it.
     *
     * Case is folded and nothing else is: no regular expressions, no whole-word,
     * no accent folding. A caller that needs those is looking for
     * [`SourceEditor`](../widgets/SourceEditor.md), which is an editor and has
     * them all.
     */
    Find(text) {
        this._needle = String(text || "");
        return this.seek(this._needle, 0, 0);
    }

    /* The next one after what is selected, wrapping round to the top. Answers
     * false when the last `Find` found nothing to look for. */
    FindNext() {
        if (!this._needle) return false;

        const range = this.range();
        return range ? this.seek(this._needle, range.To.Key, range.To.At)
                     : this.seek(this._needle, 0, 0);
    }

    /* The first match at or after that spot, then from the top. Everything about
     * where it *is* comes from the same items the draw reads, so a match that is
     * found is a match that can be shown. */
    seek(needle, fromKey, fromAt) {
        if (!needle) return false;

        const runs  = (this.laid() || []).filter((it) => it.Key !== undefined);
        const want  = needle.toLowerCase();
        const start = runs.findIndex((it) => it.Key >= fromKey);

        for (let n = 0; n < runs.length; n++) {
            /* Round the document once, beginning where we were told: the wrap is
             * what makes `FindNext` on the last match answer the first. */
            const it = runs[(Math.max(0, start) + n) % runs.length];
            const at = (it.Plain || "").toLowerCase()
                           .indexOf(want, it.Key === fromKey && n === 0 ? fromAt : 0);

            if (at < 0) continue;

            this.select({ Key: it.Key, At: at }, { Key: it.Key, At: at + needle.length });
            this.reveal(it, at, at + needle.length);
            return true;
        }
        return false;
    }

    /* Scroll so that a range of one run is on screen -- a quarter of the way
     * down, where a reader's eye is, rather than exactly at the top edge where
     * it reads as cut off. Already-visible text is left where it is: a find that
     * jumps the page when it did not have to is a find that loses the reader. */
    reveal(it, from, to) {
        const boxes = Text.Bounds(it.Markup === undefined ? it.Text : it.Markup,
                                  from, to, it.Font,
                                  { Width: it.Width, Markup: it.Markup !== undefined,
                                    Align: it.Align || "Left" });
        const box = boxes[0];
        const y   = it.Y + (box ? box.Y : 0);
        const h   = box ? box.Height : (this._lh || 16);
        const view = this.viewHeight();

        if (y >= this.Scroll && y + h <= this.Scroll + view) return;
        this.Scroll = Math.max(0, y - Math.round(view / 4));
    }

    /* The **whole** document as one PNG -- not the view: a screenshot is what a
     * screenshot tool is for. `width` is the column it is laid out at and
     * defaults to the one on screen; `scale` is 2 by default, so the text is
     * sharp at a retina size. */
    Save(path, width, scale) {
        const w = Math.max(80, Math.round(Number(width) || this.viewWidth()));
        const s = Math.max(0.1, Number(scale) || 2);

        this.measure(w, this.Canvas.Dark);
        const h = this._height;

        this._paint = { Offset: 0, From: 0, To: Infinity };
        try { this.Canvas.Save(path, Math.round(w * s), Math.round(h * s)); }
        finally { this._paint = null; this._measured = null; }
    }

    /* The document onto paper, every page in one PDF.
     *
     * This is where a viewer and `lib/report` meet: the measure has already put
     * every item at an absolute `Y`, so paginating is choosing where to cut --
     * and the cut is **pulled up to the top of whatever block straddles it**, so
     * a heading, a row or a picture is never sliced in half by a page boundary.
     * A block taller than a whole page is cut, because the alternative is a
     * blank page followed by the same problem.
     */
    SavePdf(path, paper) {
        const name = String(paper || this.Paper);
        if (!Printer.Papers[name])
            throw new Error(`SavePdf: '${name}' is not one of ${Dictionary.Keys(Printer.Papers).join(", ")}`);

        const sheet = Printer.Papers[name];
        const pages = this.paginate(sheet);

        try {
            this.Canvas.SavePdf(path, sheet.Width, sheet.Height, pages.length);
        } finally {
            this._sheets   = null;
            this._paint    = null;
            this._measured = null;
        }
        return pages.length;
    }

    /* The same pages, onto paper, through the print dialog.
     *
     * The pagination is `SavePdf`'s and the rest is
     * [`Printer`](../../docs/reference/globals/Printer.md): this works out how
     * many sheets the document is and hands them over, and `{ Copies, From, To }`
     * say the job. The answer is the dialog's, or `null` when it was cancelled.
     * **To a file it is `SavePdf`.**
     *
     * **The paper is decided here and not in the dialog**, because the cut
     * depends on it: the document is measured and paginated against the sheet
     * this is told about, so choosing another size in the dialog scales the
     * pages rather than re-flowing them. That is why `Paper` is a key here and
     * not only a preset the dialog may overrule.
     */
    Send(setup) {
        const o = setup === undefined || setup === null ? {} : setup;
        if (typeof o !== "object" || Array.isArray(o))
            throw new Error("Send expects a setup object");

        const name = String(o.Paper || this.Paper);
        if (!Printer.Papers[name])
            throw new Error(`Send: '${name}' is not one of ${Dictionary.Keys(Printer.Papers).join(", ")}`);

        const sheet = Printer.Papers[name];

        this.paginate(sheet);

        const opts = { Pages: this._sheets.length, Paper: name };
        if (o.Copies !== undefined) opts.Copies = o.Copies;
        if (o.From !== undefined)   opts.From   = o.From;
        if (o.To !== undefined)     opts.To     = o.To;

        try {
            return Printer.Send(this.Canvas, opts);
        } finally {
            this._sheets   = null;
            this._paint    = null;
            this._measured = null;
        }
    }

    /* Measure for a sheet and work out where it cuts, kept where the page
     * handler can find it. Two callers: `SavePdf` and `Send`. */
    paginate(sheet) {
        this.measure(sheet.Width, false);        /* paper is white: the light ink */
        this._sheets = this.pageBreaks(sheet.Height, this.margins());
        return this._sheets;
    }

    /* **How many sheets this document is at that size**, asked by `Printer`
     * once the dialog has settled the paper -- which is the only moment it can
     * be answered, and the moment the count that was declared may be wrong.
     *
     * A viewer laid out for A4 is more sheets on A5, and without this the
     * operation printed the number of sheets A4 needed and dropped the rest:
     * four declared, six needed, four printed, silently. Measured.
     */
    Canvas_Paginate(width, height) {
        return this.paginate({ Width: width, Height: height }).length;
    }

    /* One sheet of paper: the page arrives as an argument and this looks up the
     * band it stands for.
     *
     * **It paginates for the frame it was handed when nobody has**, which is
     * what makes `Printer.Send(doc.Canvas, …)` work on its own -- the same way
     * `Canvas_Draw` measures when it finds no measure. Without it a viewer
     * printed by anything but its own `Send` drew the *screen's* band on every
     * sheet, silently. The frame is the printable area in points, so the sheet
     * it paginates for is the paper that is really coming out.
     */
    Canvas_DrawPage(p, page, width, height) {
        const was = this._paint;

        if (!this._sheets)
            this.paginate({ Width: width, Height: height });

        this._paint = this._sheets[page - 1] || was;
        try { this.Canvas_Draw(p, width, height); }
        finally { this._paint = was; }
    }

    /* Where the pages cut. Each answer is what the draw needs and nothing more:
     * the band of the document this page shows, and how far to move it. */
    pageBreaks(paperHeight, m) {
        const items = this._items || [];
        const pages = [];
        let   from  = 0;

        while (from < this._height) {
            /* The first page carries the document's own top margin; the ones
             * after it start at the paper's. */
            const shift = from === 0 ? 0 : m.Top - from;
            const end   = from === 0 ? paperHeight - m.Bottom
                                     : from + paperHeight - m.Top - m.Bottom;

            let cut = end;
            for (const it of items) {
                const bottom = it.Y + (it.Height || 0);
                if (it.Y > from && it.Y < end && bottom > end) cut = Math.min(cut, it.Y);
            }
            if (cut <= from) cut = end;          /* taller than a page: cut it */

            pages.push({ Offset: shift, From: from, To: cut });
            from = cut;
        }
        return pages.length ? pages : [{ Offset: 0, From: 0, To: paperHeight }];
    }

    /* ------------------------------------------------------------- plumbing */

    margins() {
        const m = this.Margins;
        return typeof m === "number" ? { Top: m, Right: m, Bottom: m, Left: m } : m;
    }

    /* The width a measure that nobody gave one runs at: what GTK has allocated,
     * what the form declared, or a column of a readable width -- in that order,
     * because the first of them that is not zero is the truest. */
    viewWidth() {
        const had = this.Canvas ? this.Canvas.Bounds().Width : 0;
        return had || this.Width || 600;
    }

    viewHeight() {
        const had = this.Canvas ? this.Canvas.Bounds().Height : 0;
        return had || this.Height || 400;
    }

    /* The measure is dropped, not redone: the next frame or the next question
     * does it, so a run of assignments costs one pass. */
    remeasure() { this._measured = null; this.redraw(); }

    redraw() { if (this.Canvas) this.Canvas.Redraw(); }

    /* Measured at the width and theme it is standing in, if it is not already.
     * Called from the draw -- where the real width finally is -- and from every
     * question that has to answer before a frame. */
    ensure(width, dark) {
        /* An export has measured at a width of its own choosing and is mid-way
         * through drawing it; a question asked from in there is answered about
         * the document that is being exported. */
        if (this._paint) return;

        const w = width === undefined ? this.viewWidth() : width;
        const d = dark  === undefined ? (this.Canvas ? this.Canvas.Dark : false) : dark;

        if (this._measured && this._measured.Width === w && this._measured.Dark === d)
            return;
        this.measure(w, d);
    }

    /* --------------------------------------------------------- the selection
     *
     * Three things, and the middle one is the whole of it: **where a point is in
     * the text**. A document made of controls would get that from the toolkit;
     * a document that is drawn has to ask the same layout it drew with, which is
     * what `Text.IndexAt` and `Text.Bounds` were added for -- the pair of calls
     * that turn a pointer into an offset and an offset back into rectangles.
     */

    /* The measured items, measuring first if nobody has: `SelectAll` and the
     * hit test both have to work before a frame has been drawn. */
    laid() { this.ensure(); return this._items; }

    /* The selection in document order, or `null`. The anchor is where the drag
     * started and may be *after* where it is now. */
    range() {
        const sel = this._sel;
        if (!sel || !sel.From || !sel.To) return null;

        const back = sel.To.Key < sel.From.Key ||
                     (sel.To.Key === sel.From.Key && sel.To.At < sel.From.At);
        const from = back ? sel.To : sel.From;
        const to   = back ? sel.From : sel.To;

        if (from.Key === to.Key && from.At === to.At) return null;
        return { From: from, To: to };
    }

    /* Set it, repaint, and say so -- once, and not on every pixel of a drag:
     * `Select` is what a *Copy* button listens to, and a host that re-read the
     * selection sixty times a second while the pointer moved would be doing the
     * work of one mouse-up sixty times. */
    select(from, to) {
        this._sel = from && to ? { From: from, To: to } : null;
        this.redraw();
        this.Emit("Select", this.Selection);
    }

    /* Which run of text a point is in, and where in it.
     *
     * A point between two blocks belongs to the one above -- at its end -- so
     * that dragging down the gutter of a document selects whole paragraphs
     * rather than nothing at all. A point in a band that several runs share (a
     * row of table cells) belongs to the nearest one across.
     */
    spotAt(x, y) {
        const items = this.laid() || [];
        const docY  = y + this.Scroll;

        const on = items.filter((it) => it.Key !== undefined &&
                                        docY >= it.Y && docY <= it.Y + it.Height);
        if (on.length) {
            let hit = on[0], nearest = Infinity;

            for (const it of on) {
                const away = x < it.X ? it.X - x
                           : x > it.X + it.Width ? x - it.X - it.Width : 0;
                if (away < nearest) { nearest = away; hit = it; }
            }
            return { Key: hit.Key, At: this.indexIn(hit, x - hit.X, docY - hit.Y) };
        }

        let above = null, below = null;
        for (const it of items) {
            if (it.Key === undefined) continue;
            if (it.Y + it.Height < docY) above = it;
            else if (!below) below = it;
        }
        if (above) return { Key: above.Key, At: (above.Plain || "").length };
        if (below) return { Key: below.Key, At: 0 };
        return null;
    }

    /* The character at a point inside one run, in the run's own coordinates.
     * **The same string and the same options the item was measured and drawn
     * with**, which is what makes the answer the character the reader is
     * pointing at rather than one a second layout thought was there. */
    indexIn(it, x, y) {
        return Text.IndexAt(it.Markup === undefined ? it.Text : it.Markup, x, y, it.Font,
                            { Width: it.Width, Markup: it.Markup !== undefined,
                              Align: it.Align || "Left" });
    }

    /*
     * The link under a point, or nothing.
     *
     * **Tested against the rectangles the words really occupy** and not against
     * the character index at the point: `IndexAt` clamps a point past the end of
     * a line onto that line, so a click in the empty half of a line that ends in
     * a link would have followed it. `Text.Bounds` is the same call the
     * selection paints with, which is what makes *the link is where it looks
     * like it is* true rather than nearly true.
     */
    linkAt(x, y) {
        const docY = y + this.Scroll;

        for (const it of this._items || []) {
            if (!it.Links || !it.Links.length) continue;
            if (docY < it.Y || docY > it.Y + it.Height) continue;
            if (x < it.X || x > it.X + it.Width) continue;

            for (const link of this.linkBoxes(it))
                for (const box of link.Boxes)
                    if (x >= it.X + box.X && x <= it.X + box.X + box.Width &&
                        docY >= it.Y + box.Y && docY <= it.Y + box.Y + box.Height)
                        return link;
        }
        return null;
    }

    /* One `Text.Bounds` per link, worked out the first time the pointer is over
     * the run that holds it and kept on the item -- which lasts exactly as long
     * as it should, since a re-measure builds new items. A document of two
     * hundred links costs nothing until somebody points at one. */
    linkBoxes(it) {
        if (!it.Boxes)
            it.Boxes = it.Links.map((link) => ({
                Href:  link.Href,
                Text:  (it.Plain || "").slice(link.From, link.To),
                Boxes: Text.Bounds(it.Markup, link.From, link.To, it.Font,
                                   { Width: it.Width, Markup: true,
                                     Align: it.Align || "Left" }),
            }));
        return it.Boxes;
    }

    /*
     * A link was clicked.
     *
     * **The host gets first refusal**, the way a key does: `Link` is emitted,
     * and a handler that answers `true` has dealt with it. What is left over and
     * points inside this document -- `#a-heading` -- scrolls, because that is
     * the one address a viewer can honour on its own and the one nobody should
     * have to write a handler for. Everything else is the host's: where
     * `./other.md` or `https://…` should open is a decision about the
     * application and not about the document.
     */
    follow(link) {
        if (this.Emit("Link", link.Href, link.Text) === true) return true;
        if (link.Href.startsWith("#")) return this.ScrollTo(link.Href);
        return false;
    }

    itemOf(key) {
        return (this.laid() || []).find((it) => it.Key === key) || null;
    }

    /* What a double click takes: the word under it, or the whitespace run under
     * it when there is no word there. */
    wordAt(spot) {
        const it = this.itemOf(spot.Key);
        if (!it) return null;

        const text = it.Plain === undefined ? "" : it.Plain;
        const word = (c) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);

        if (!text) return null;

        let from = Math.min(spot.At, text.length - 1);
        let to   = from;

        if (!word(text[from]) && from > 0 && word(text[from - 1])) from = to = from - 1;

        while (from > 0 && word(text[from - 1])) from--;
        while (to < text.length && word(text[to])) to++;

        if (from === to) {                       /* not on a word: take the gap */
            while (to < text.length && !word(text[to])) to++;
        }
        return { From: { Key: it.Key, At: from }, To: { Key: it.Key, At: to } };
    }

    /* ------------------------------------------------------------- measure
     *
     * The first pass, and the one that costs something: it walks the blocks and
     * produces a flat list of **display items** -- a run of markup, a rule, a
     * panel, a picture -- each with an absolute `Y` in the document. It runs
     * when the text, the width, the theme or a font changes, and **not when the
     * view is scrolled**: that is the whole of what the two passes buy, and it
     * is the same bargain `lib/report` makes with its pages.
     *
     * It never touches a `Painter`. `Text.Size` answers with no frame open,
     * which is what lets `ContentHeight` and `Headings` be read in `Form_Open`
     * before anything has been drawn.
     */
    measure(width, dark) {
        const ink  = { ...(dark ? DARK : LIGHT) };
        const base = faceOf(this.BaseFont, Text.Font || "Sans 11");
        const code = faceOf(this.CodeFont, `Monospace ${base.Size}`);

        ink.CodeFamily = code.Name;

        const body = sized(base, 1, false);
        const lh   = Text.Height("0", body) || Math.round(base.Size * 1.4);
        const m    = this.margins();

        const room   = Math.max(80, width - m.Left - m.Right);
        const column = this.MaxWidth > 0 ? Math.min(this.MaxWidth, room) : room;
        /* Centred when it is narrower than the room there is, which is what
         * `MaxWidth` is for: a document pinned to the left of a wide window
         * reads like a mistake. */
        const x0 = Math.max(m.Left, Math.round((width - column) / 2));

        /* `keys` numbers the runs of text a reader can select, in the order they
         * are laid out. **It is what a selection survives a resize by**: an item
         * is rebuilt at every width, so an offset into `_items` would mean a
         * different paragraph after one; the Nth run of text is the same words
         * whatever the column. */
        const ctx = { ink, base, code, body, lh, color: ink.Ink, keys: 0,
                      items: [], headings: [] };
        const y = this.layout(ctx, this._blocks || [], x0, column, m.Top, 0, false);

        this._items    = ctx.items;
        this._headings = ctx.headings;
        this._lh       = lh;
        this._height   = Math.ceil(y + m.Bottom);
        this._measured = { Width: width, Dark: dark };

        /* A document that shrank under its own scroll would otherwise show the
         * blank below its last line.
         *
         * **Clamped against the numbers in hand and not through `ScrollMax`**:
         * that getter asks `ContentHeight`, which measures when the width it is
         * standing at is not the one that was measured -- and the export
         * measures at the paper's width. Reading it here called this function
         * again, from inside itself, and the second pass overwrote the first:
         * an export came out at the width of the window every time. */
        this._top = Math.max(0, Math.min(this._top || 0,
                                         Math.max(0, this._height - this.viewHeight())));
    }

    /*
     * The inline pass for one block, kept.
     *
     * What a block draws as depends on its text and on the **palette** -- a link
     * and a code span carry their colour inside the markup -- and not on the
     * width. A resize re-measures every block, and without this it re-parsed
     * every paragraph to produce exactly the same string it had. Measured on a
     * 72 KB document (`docs/llm/controls.md`): a second measure costs 204 ms
     * against 666.
     *
     * **Keyed on everything the markup carries** -- the link and code colours and
     * the monospace family, not just the ink. It was the ink alone, and a theme
     * that moved invalidated by luck: `CodeFont` changed under the same theme
     * reused the markup it already had, so the code spans stayed in the family
     * the document was opened with. A key that covers less than what goes into
     * the string is a cache that is right most of the time.
     */
    runs(b, ink) {
        const key = `${ink.Ink}|${ink.Link}|${ink.Code}|${ink.CodeFamily}`;

        if (b.Runs === undefined || b.RunsInk !== key) {
            b.Runs = b.Kind === "Table"
                ? { Head: b.Head.map((c) => inline(c, ink)),
                    Rows: b.Rows.map((r) => r.map((c) => inline(c, ink))) }
                : inline(b.Text, ink);          /* { Markup, Plain, Links } */
            b.RunsInk = key;
        }
        return b.Runs;
    }

    /* A run of blocks down a column, each under the last. The gap between them
     * is a proportion of the line height rather than a number of pixels, so a
     * document set larger is spaced larger. */
    layout(ctx, list, x, w, y, depth, tight) {
        for (let i = 0; i < list.length; i++) {
            const b = list[i];

            if (i) y += Math.round(ctx.lh * (tight ? 0.15 : GAP));
            /* A heading opens a section, and the room above it is what says so
             * -- but not at the very top of a document, where there is nothing
             * to be separated from. */
            if (i && b.Kind === "Heading") y += Math.round(ctx.lh * (HEAD_ABOVE - GAP));

            y = this.block(ctx, b, x, w, y, depth);
        }
        return y;
    }

    /* One block, from `y` to whatever it reaches. Every branch ends in items
     * pushed and a number returned: nothing here draws, and nothing here knows
     * what a `Painter` is. */
    block(ctx, b, x, w, y, depth) {
        const ink = ctx.ink;

        if (b.Kind === "Heading") {
            const font = sized(ctx.base, HEADINGS[Math.min(6, b.Level) - 1], true);
            const runs = this.runs(b, ink);
            const size = Text.Size(runs.Markup, font, { Width: w, Markup: true });

            ctx.headings.push({ Level: b.Level, Text: b.Plain, Id: b.Id, Y: y });
            ctx.items.push({ Kind: "Text", X: x, Y: y, Width: w, Height: size.Height,
                             Markup: runs.Markup, Plain: runs.Plain, Links: runs.Links,
                             Key: ctx.keys++, Font: font, Color: ink.Ink });
            y += size.Height;

            /* A rule under the top two levels, which is what a document does to
             * say a section started -- and the one piece of styling here that is
             * not in the source. */
            if (b.Level <= 2) {
                y += Math.round(ctx.lh * 0.3);
                ctx.items.push({ Kind: "Rule", X: x, Y: y, Width: w, Height: 1,
                                 Color: ink.Rule });
                y += 1;
            }
            return y;
        }

        if (b.Kind === "Image") return this.picture(ctx, b, x, w, y);

        if (b.Kind === "Paragraph") {
            const runs = this.runs(b, ink);
            const size = Text.Size(runs.Markup, ctx.body, { Width: w, Markup: true });

            ctx.items.push({ Kind: "Text", X: x, Y: y, Width: w, Height: size.Height,
                             Markup: runs.Markup, Plain: runs.Plain, Links: runs.Links,
                             Key: ctx.keys++, Font: ctx.body, Color: ctx.color });
            return y + size.Height;
        }

        if (b.Kind === "Code") {
            const font = sized(ctx.code, 1, false);
            const pad  = Math.round(ctx.lh * PAD);
            const room = Math.max(20, w - 2 * pad);
            /* Wrapped and not clipped: a code block wider than the column is
             * usual -- a long command, a path -- and a reader who cannot scroll
             * sideways would simply not have the end of the line. The wrap is
             * visible as a wrap because nothing else in a code block is. */
            const size = Text.Size(b.Text || " ", font, { Width: room });

            ctx.items.push({ Kind: "Rect", X: x, Y: y, Width: w,
                             Height: size.Height + 2 * pad, Color: ink.Panel,
                             Radius: Math.round(ctx.lh * 0.25) });
            ctx.items.push({ Kind: "Text", X: x + pad, Y: y + pad, Width: room,
                             Height: size.Height, Text: b.Text, Plain: b.Text,
                             Key: ctx.keys++, Font: font, Color: ink.Ink });
            return y + size.Height + 2 * pad;
        }

        if (b.Kind === "Rule") {
            y += Math.round(ctx.lh * 0.4);
            ctx.items.push({ Kind: "Rule", X: x, Y: y, Width: w, Height: 1,
                             Color: ink.Rule });
            return y + 1 + Math.round(ctx.lh * 0.4);
        }

        if (b.Kind === "Quote") {
            const step = Math.round(ctx.lh * 0.9);
            const was  = ctx.color;

            ctx.color = ink.Dim;
            const bottom = this.layout(ctx, b.Blocks, x + step, Math.max(40, w - step),
                                       y, depth, false);
            ctx.color = was;

            /* The bar is as tall as what it quotes, which is why it is measured
             * afterwards and not before. */
            ctx.items.push({ Kind: "Rect", X: x, Y: y, Width: 3, Height: bottom - y,
                             Color: ink.Rule, Radius: 1 });
            return bottom;
        }

        if (b.Kind === "List") {
            const step = Math.round(ctx.lh * INDENT);
            const gap  = Math.round(ctx.lh * 0.35);

            for (let k = 0; k < b.Items.length; k++) {
                if (k) y += Math.round(ctx.lh * (b.Tight ? 0.2 : GAP));

                const marker = b.Ordered ? `${b.Start + k}.` : BULLETS[depth % BULLETS.length];
                const mw     = Text.Width(marker, ctx.body);

                /* The marker hangs to the left of the item's own column, which
                 * is what makes a wrapped line start under the text and not
                 * under the bullet. */
                ctx.items.push({ Kind: "Text", X: x + step - mw - gap, Y: y, Width: mw,
                                 Text: marker, Font: ctx.body, Color: ctx.color });

                y = this.layout(ctx, b.Items[k], x + step, Math.max(40, w - step),
                                y, depth + 1, b.Tight);
            }
            return y;
        }

        if (b.Kind === "Table") return this.table(ctx, b, x, w, y);
        return y;
    }

    /*
     * A table, which is the one block that has to decide a width before it can
     * measure a height.
     *
     * Each column asks for what its widest cell would take unwrapped; if the
     * row is wider than the column they are **shrunk in proportion**, with a
     * floor, and the cells wrap inside what they end up with. That is the
     * behaviour of every table that has to fit in a column of text, and the
     * alternative -- a table that runs off the side -- is one a reader cannot
     * scroll to.
     */
    table(ctx, b, x, w, y) {
        const ink  = ctx.ink;
        const head = sized(ctx.base, 1, true);
        const pad  = Math.round(ctx.lh * PAD);
        const cols = b.Head.length;

        const cells = this.runs(b, ink);
        const heads = cells.Head.map((c) => c.Markup);
        const rows  = cells.Rows.map((r) => r.map((c) => c.Markup));

        /* What each column would take unwrapped, and what it cannot go below
         * without breaking a word in half. The pair is what a table layout is:
         * squeeze the column with the most room to give, and never squeeze one
         * past its longest word while another still has slack. */
        const want = heads.map((c, i) => {
            let widest = Text.Size(c, head, { Markup: true }).Width;
            for (const row of rows)
                widest = Math.max(widest, Text.Size(row[i], ctx.body, { Markup: true }).Width);
            return widest + 2 * pad;
        });

        const code = sized(ctx.code, 1, false);
        const need = b.Head.map((c, i) => {
            let word = longest(c, head, code);
            for (const row of b.Rows) word = Math.max(word, longest(row[i], ctx.body, code));
            return Math.min(want[i], word + 2 * pad);
        });

        const sum    = (list) => list.reduce((a, n) => a + n, 0);
        const total  = sum(want);
        let   widths = want;

        if (total > w) {
            const least = sum(need);

            /* Even the longest words do not fit: everything shrinks in
             * proportion and Pango breaks what it must. A table of one very
             * long word per column is a table that cannot be drawn. */
            if (least >= w) {
                widths = need.map((n) => Math.max(10, Math.round(n * w / least)));
            } else {
                const slack = w - least;
                const over  = sum(want.map((n, i) => n - need[i])) || 1;
                widths = need.map((n, i) => n + Math.round(slack * (want[i] - need[i]) / over));
            }
        }

        const row = (cellsOf, runOf, font, top, fill) => {
            let height = 0;
            let cx     = x;

            const sizes = cellsOf.map((c, i) => {
                const room = Math.max(10, widths[i] - 2 * pad);
                const size = Text.Size(c, font, { Width: room, Markup: true });
                height = Math.max(height, size.Height);
                return size;
            });

            if (fill)
                ctx.items.push({ Kind: "Rect", X: x, Y: top,
                                 Width: widths.reduce((a, n) => a + n, 0),
                                 Height: height + 2 * pad, Color: ink.Panel });

            cellsOf.forEach((c, i) => {
                ctx.items.push({ Kind: "Text", X: cx + pad, Y: top + pad,
                                 Width: Math.max(10, widths[i] - 2 * pad),
                                 Height: sizes[i].Height, Markup: c,
                                 Plain: runOf(i).Plain, Links: runOf(i).Links,
                                 Key: ctx.keys++, Font: font,
                                 Color: ctx.color, Align: b.Align[i] || "Left" });
                cx += widths[i];
            });
            return top + height + 2 * pad;
        };

        /* **A header row with nothing in it is not a header.** A table whose
         * first row is `| | |` is how a reference page writes a two-column list
         * of members -- `docs/llm/controls.md` is hundreds of them -- and drawing
         * the heading band anyway puts an empty grey strip over every one. What
         * the source says there is *no headings*, and that is what is drawn. */
        const titled = b.Head.some((c) => c.trim() !== "");

        let bottom = titled ? row(heads, (i) => cells.Head[i], head, y, true) : y;

        for (let n = 0; n < rows.length; n++) {
            const r = rows[n];

            if (titled || n) {
                ctx.items.push({ Kind: "Rule", X: x, Y: bottom,
                                 Width: widths.reduce((a, n) => a + n, 0), Height: 1,
                                 Color: ink.Rule });
                bottom += 1;
            }
            bottom = row(r, (i) => cells.Rows[n][i], ctx.body, bottom, false);
        }
        return bottom;
    }

    /*
     * A picture on a line of its own.
     *
     * Its natural size comes from a hidden `Picture` -- the only thing here that
     * can answer what is really in a file, since `Painter.Image` draws one and
     * does not measure it. It is asked once per file and remembered: a document
     * with the same logo in it four times decodes it once.
     *
     * **A picture is never enlarged**, only fitted: a 40px icon in a 700px
     * column is a 40px icon, because a document that blew its own icons up to
     * the width of the text would be unreadable in a way nobody asked for.
     */
    picture(ctx, pic, x, w, y) {
        const file = this.resolve(pic.File);
        const size = this.imageSize(file);

        if (!size.Width || !size.Height) {
            /* Nothing readable there: a box with the alt text in it, which is
             * what a document with a broken picture should look like. Not a
             * throw -- see the header. */
            const height = Math.round(ctx.lh * 2.5);
            ctx.items.push({ Kind: "Missing", X: x, Y: y, Width: Math.min(w, 320),
                             Height: height, Alt: pic.Alt || File.Name(file),
                             Font: ctx.body, Color: ctx.ink.Dim });
            return y + height;
        }

        const width  = Math.min(w, size.Width);
        const height = Math.round(size.Height * width / size.Width);

        ctx.items.push({ Kind: "Image", X: x, Y: y, Width: width, Height: height,
                         File: file, Alt: pic.Alt, Font: ctx.body,
                         Color: ctx.ink.Dim });
        return y + height;
    }

    /* Where a picture's path points. Relative to the document's own folder when
     * it came from a file -- which is what a Markdown file means by
     * `![](images/a.png)` -- and to the project otherwise. */
    resolve(file) {
        const said = String(file);
        if (said.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(said)) return said;

        const from = this.Path ? File.Directory(this.Path) : Application.Directory;
        return File.Join(from, said);
    }

    /* What is really in the file, `{ Width: 0 }` for anything that cannot be
     * read as a picture. */
    imageSize(file) {
        if (!this._sizes) this._sizes = {};
        if (file in this._sizes) return this._sizes[file];

        let size = { Width: 0, Height: 0 };
        try {
            if (File.Exists(file)) {
                /* Made, asked and destroyed: the answer is remembered below, so
                 * a document with the same logo in it four times asks once --
                 * and no document leaves a widget lying about for the sake of a
                 * number. */
                const probe = new Picture();
                try {
                    probe.File = file;
                    size = { Width: probe.SourceWidth, Height: probe.SourceHeight };
                } finally {
                    probe.Delete();
                }
            }
        } catch (e) {
            /* Not a picture, or no display to decode one on. The document still
             * draws; the box says which file it was. */
        }
        this._sizes[file] = size;
        return size;
    }

    /* ------------------------------------------------------------- drawing
     *
     * The second pass: the items the measure worked out, the ones the viewport
     * is standing over, painted. Scrolling is a `Translate` and a filter, which
     * is why a document of four hundred blocks scrolls at the cost of the
     * dozen that are on screen.
     */
    Canvas_Draw(p, width, height) {
        /* `_paint` is the export's override -- a page of a PDF, or the whole
         * document as one picture. The only difference between a frame and an
         * export is which band of the document it wants and where it puts it. */
        const out = this._paint;

        if (!out) this.ensure(width, p.Dark);
        const ink = this.palette();

        /* A frame paints no ground: the component sits in the application's own
         * window and the theme's is right. An export does, because a PNG with
         * nothing behind the letters is transparent and a PDF is paper. */
        if (out) {
            p.Color = ink.Ground;
            p.Rectangle(0, 0, width, height);
            p.Fill();
        }

        const from = out ? out.From : this.Scroll;
        const to   = out ? out.To   : this.Scroll + height;
        const dy   = out ? out.Offset : -this.Scroll;

        /* **An export carries no selection.** A PDF of a document with three
         * words highlighted in it is a PDF of somebody's pointer, not of the
         * document. */
        const range = out ? null : this.range();

        p.Push();
        p.Translate(0, dy);

        for (const it of this._items || []) {
            if (it.Y + (it.Height || 0) < from || it.Y > to) continue;
            if (range) this.drawSelection(p, it, range, ink);
            this.drawItem(p, it, ink);
        }
        p.Pop();

        if (!out) this.scrollbar(p, width, height, ink);
    }

    /*
     * The selection behind one run of text.
     *
     * The rectangles come from `Text.Bounds`, which asks the layout the text was
     * measured with -- so the highlight ends where the line ends, follows the
     * wrap, and lands in the right place in a centred or right-aligned cell.
     * Anything worked out here from character widths would be a second opinion
     * about where the letters are, and would be wrong first on the line that
     * wrapped.
     */
    drawSelection(p, it, range, ink) {
        if (it.Key === undefined || it.Key < range.From.Key || it.Key > range.To.Key)
            return;

        const text = it.Plain === undefined ? "" : it.Plain;
        const from = it.Key === range.From.Key ? range.From.At : 0;
        const to   = it.Key === range.To.Key   ? range.To.At   : text.length;
        if (to <= from) return;

        const boxes = Text.Bounds(it.Markup === undefined ? it.Text : it.Markup,
                                  from, to, it.Font,
                                  { Width: it.Width, Markup: it.Markup !== undefined,
                                    Align: it.Align || "Left" });
        p.Push();
        p.Color = ink.Select;
        for (const box of boxes)
            p.Rectangle(it.X + box.X, it.Y + box.Y, box.Width, box.Height);
        p.Fill();
        p.Pop();
    }

    /* Every item gets its own `Push`/`Pop`, so one block's colour, pen or clip
     * can never leak into the next -- the same rule `lib/report` draws bands
     * by. The font is not one of those and is assigned per item: `Push` saves
     * the colour, the pen, the transform and the clip, and the font lives on
     * the layout instead. */
    drawItem(p, it, ink) {
        p.Push();
        try {
            if (it.Kind === "Rect") {
                p.Color = it.Color;
                this.box(p, it.X, it.Y, it.Width, it.Height, it.Radius || 0);
                p.Fill();
            } else if (it.Kind === "Rule") {
                p.Color     = it.Color;
                p.LineWidth = 1;
                p.MoveTo(it.X, it.Y + 0.5);
                p.LineTo(it.X + it.Width, it.Y + 0.5);
                p.Stroke();
            } else if (it.Kind === "Image") {
                this.drawImage(p, it, ink);
            } else if (it.Kind === "Missing") {
                this.drawMissing(p, it, ink);
            } else {
                p.Font  = it.Font;
                p.Color = it.Color;
                /* One call for the whole paragraph -- the tags, the wrap and
                 * the alignment are Pango's, which is the point of the markup:
                 * the lines it breaks here are the ones the measure counted. */
                p.Text(it.Markup === undefined ? it.Text : it.Markup, it.X, it.Y,
                       { Width: it.Width, Markup: it.Markup !== undefined,
                         Align: it.Align || "Left" });
            }
        } finally {
            p.Pop();
        }
    }

    /* A picture, and a box where one was meant to be. A file that vanished
     * between the measure and the frame is the ordinary case in a viewer -- a
     * document open while its folder is being tidied -- so the throw is caught
     * here rather than ending the frame. */
    drawImage(p, it, ink) {
        try {
            p.Image(it.File, it.X, it.Y, it.Width, it.Height);
        } catch (e) {
            this.drawMissing(p, it, ink);
        }
    }

    drawMissing(p, it, ink) {
        p.Color     = ink.Rule;
        p.LineWidth = 1;
        p.LineDash  = [3, 3];
        p.Rectangle(it.X + 0.5, it.Y + 0.5, it.Width - 1, it.Height - 1);
        p.Stroke();

        p.LineDash = [];
        p.Font     = it.Font;
        p.Color    = ink.Dim;
        p.Text(it.Alt || "", it.X + 8, it.Y + Math.max(2, (it.Height - this._lh) / 2),
               { Width: Math.max(10, it.Width - 16) });
    }

    /* A rounded rectangle, which cairo has no call for: four arcs and the sides
     * between them. A radius of nothing is the plain rectangle. */
    box(p, x, y, w, h, r) {
        if (r <= 0) { p.Rectangle(x, y, w, h); return; }

        const rad = Math.min(r, w / 2, h / 2);
        p.MoveTo(x + rad, y);
        p.LineTo(x + w - rad, y);
        p.Arc(x + w - rad, y + rad, rad, -90, 0);
        p.LineTo(x + w, y + h - rad);
        p.Arc(x + w - rad, y + h - rad, rad, 0, 90);
        p.LineTo(x + rad, y + h);
        p.Arc(x + rad, y + h - rad, rad, 90, 180);
        p.LineTo(x, y + rad);
        p.Arc(x + rad, y + rad, rad, 180, 270);
        p.ClosePath();
    }

    /*
     * The scrollbar, drawn.
     *
     * A component whose whole surface is one `DrawingArea` has no GTK scrollbar
     * to borrow: a `Scroller` puts its child on a fixed surface at the size the
     * child asks for, and a drawing has no size of its own to ask with -- which
     * is the reason this is not a `Scroller` with a tall canvas in it. What it
     * needs instead is four rectangles, and it gets to be the overlay indicator
     * every document viewer has had for ten years.
     */
    scrollbar(p, width, height, ink) {
        const max = this.ScrollMax;
        if (max <= 0) { this._thumb = null; return; }

        const w    = 6;
        const edge = 3;
        const room = height - 2 * edge;
        const size = Math.max(24, Math.round(room * height / this._height));
        const at   = edge + Math.round((room - size) * this.Scroll / max);

        p.Push();
        p.Color = ink.Rule;
        this.box(p, width - w - edge, at, w, size, w / 2);
        p.Fill();
        p.Pop();

        /* Remembered for the drag: the thumb is where it was last painted, and
         * a hit test against anything else would be a second opinion. */
        this._thumb = { X: width - w - edge * 2, Y: at, Width: w + edge * 2,
                        Height: size, Track: room };
    }

    palette() {
        const ink = { ...(this._measured && this._measured.Dark ? DARK : LIGHT) };
        ink.CodeFamily = faceOf(this.CodeFont, "Monospace 11").Name;
        return ink;
    }

    /* ---------------------------------------------------------------- input
     *
     * A document scrolls with the wheel, with the keys a reader expects, and by
     * dragging the indicator. Nothing here is a widget doing it for us, which
     * is the price of drawing the document -- and it is forty lines.
     */
    Canvas_MouseWheel(dx, dy) {
        if (this.ScrollMax <= 0) return false;

        this.Scroll = this.Scroll + dy * (this._lh || 16) * 3;
        /* Consumed, so a `Scroller` this component is sitting in does not also
         * move: two things scrolling on one notch is the worst of both. */
        return true;
    }

    Canvas_MouseDown(x, y, button) {
        /* The keys only arrive at a control that has the focus, and a document
         * somebody clicked on is the one they mean to page through. */
        this.Canvas.SetFocus();

        const t = this._thumb;
        if (t && x >= t.X && x <= t.X + t.Width && y >= t.Y && y <= t.Y + t.Height) {
            this._drag = { At: y, From: this.Scroll, Track: t.Track, Size: t.Height };
            return;
        }
        /* Anywhere else on the bar jumps there, which is what a click on a
         * track has always done. */
        if (t && x >= t.X) {
            this.Scroll = Math.round(this.ScrollMax * y / this.viewHeight());
            return;
        }

        /* **The right button keeps the selection**, because what it opens is a
         * menu about it. Only the left one starts a new one. */
        if (button !== 1) return;

        this._anchor  = this.spotAt(x, y);
        this._picking = !!this._anchor;

        /* **Cleared here and announced at the mouse-up**, which is the same rule
         * the drag follows: a click on a document that had something selected
         * used to say `Select("")` twice -- once for the clearing and once for
         * the button coming up -- and a host that enables a *Copy* button on it
         * saw it flicker. */
        if (this._sel) {
            this._sel = null;
            this.redraw();
        }
    }

    Canvas_MouseMove(x, y) {
        if (this._drag) {
            /* The thumb travels the track less its own length while the
             * document travels `ScrollMax`: any other ratio and the document
             * arrives at its end before the pointer does. */
            const travel = Math.max(1, this._drag.Track - this._drag.Size);
            this.Scroll  = this._drag.From +
                           (y - this._drag.At) * this.ScrollMax / travel;
            return;
        }

        if (this._picking) {
            const head = this.spotAt(x, y);
            if (!head) return;

            /* Repainted on every move and **announced on none**: `Select` is a
             * mouse-up. See `select`, which is why this one writes the state by
             * hand. */
            this._sel = { From: this._anchor, To: head };
            this.redraw();
            return;
        }
        this.pointer(x, y);
    }

    Canvas_MouseUp(x, y, button) {
        const picked = this._picking;

        this._drag    = null;
        this._picking = false;

        /* **A click is a drag that selected nothing**, which is the whole test:
         * following a link on the way *down* would take the document away from
         * under somebody who meant to select its words, and a drag that covered
         * text is not a click however short it was. */
        if (picked && button === 1 && !this.range()) {
            const link = this.linkAt(x, y);
            if (link) { this.follow(link); return; }
        }

        /* The drag is over: now say what came of it -- including that it came to
         * nothing, since a click that clears a selection is news to a *Copy*
         * button too. */
        if (picked) this.Emit("Select", this.Selection);
    }

    /* A word, which is what a double click has meant since before any of this.
     * A third click would be the paragraph; there is no `TplClick` to hang it
     * on, and `SelectAll` is the verb for the document. */
    Canvas_DblClick(x, y, button) {
        if (button !== 1) return;

        const spot = this.spotAt(x, y);
        const word = spot && this.wordAt(spot);

        if (word) this.select(word.From, word.To);
    }

    /* What the pointer looks like: a text cursor over text and the arrow over
     * everything else, written only when it changes -- a property assignment per
     * mouse move is a GTK call per mouse move. */
    pointer(x, y) {
        const over = this.linkAt(x, y) ? "Hand"
                   : this.overText(x, y) ? "Text" : "Auto";

        if (over !== this._cursor) {
            this._cursor       = over;
            this.Canvas.Cursor = over;
        }
    }

    overText(x, y) {
        const t = this._thumb;
        if (t && x >= t.X) return false;

        const docY = y + this.Scroll;
        return (this._items || []).some((it) => it.Key !== undefined &&
                                                docY >= it.Y && docY <= it.Y + it.Height &&
                                                x >= it.X && x <= it.X + it.Width);
    }

    Canvas_KeyPress(key, ctrl) {
        const line = (this._lh || 16) * 3;
        const page = Math.max(40, this.viewHeight() - (this._lh || 16) * 2);

        if (ctrl && (key === "c" || key === "C")) return this.Copy();
        if (ctrl && (key === "a" || key === "A")) return this.SelectAll();

        switch (key) {
        case "Down":                    this.Scroll += line; return true;
        case "Up":                      this.Scroll -= line; return true;
        case "Page_Down": case "space": this.Scroll += page; return true;
        case "Page_Up":                 this.Scroll -= page; return true;
        case "Home":                    this.Scroll = 0; return true;
        case "End":                     this.Scroll = this.ScrollMax; return true;
        case "Escape":                  return this.Deselect();
        default:                        return false;
        }
    }
}
