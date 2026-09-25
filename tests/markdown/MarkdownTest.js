/*
 * `lib/markdown`, held to what [docs/llm/markdown.md](../../docs/llm/markdown.md)
 * promises.
 *
 * **Everything here is synchronous, and that is the whole trick.** `Save()` runs
 * the same `Canvas_Draw` against an image surface and returns, so
 * `Canvas.Dump()` on the line after it is *that document's* calls -- which is
 * how a drawn document is asserted without a screen and without waiting for a
 * frame. It is the bargain `tests/report` makes, and it is why a viewer that
 * draws its own text can be tested at all.
 *
 * The dump is also where the **markup** is visible: a paragraph arrives as one
 * `Text` call carrying its own `<b>` and `<span>`, which is the thing this
 * library asked the runtime for. A test that only measured heights would pass
 * with every word in the same font.
 *
 * Three of these assertions are regressions, and each one shipped once:
 *
 *   - the measure called itself from inside itself -- clamping the scroll read
 *     `ScrollMax`, which measures when the width is not the one it last used,
 *     and the export's width never survived its own first pass;
 *   - a document with no `Ground` in its palette threw on every export;
 *   - `Text.Lines` was asked for the lines of a styled paragraph, which are
 *     runs and not strings.
 */
"use strict";

/* Tagged with what the runner passed -- its pid -- so two suites at once do not
 * share a scratch directory.  See tests/run.sh. */
const SCRATCH = `/tmp/bta-test-markdown${Application.Arguments[0] ? `-${Application.Arguments[0]}` : ""}`;

let passed = 0;
const failures = [];

function check(name, cond, detail) {
    if (cond) passed++;
    else failures.push(detail ? `${name}: ${detail}` : name);
}

function eq(name, got, want) {
    check(name, got === want, `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

function throws(name, fn) {
    try {
        fn();
        failures.push(`${name}: expected a throw, none happened`);
    } catch (e) {
        passed++;
    }
}

/* A document with one of everything in it, which is what most of the assertions
 * below are read off. */
const SAMPLE = [
    "# Title",
    "",
    "A paragraph with **bold**, *italic*, `code`, ~~struck~~ and a [link](http://x).",
    "",
    "Second paragraph, with a < b & c in it and snake_case left alone.",
    "",
    "## Second",
    "",
    "- one",
    "- two",
    "  - nested",
    "",
    "7. seven",
    "8. eight",
    "",
    "> quoted",
    "",
    "```js",
    "const a = 1;",
    "```",
    "",
    "| a | b |",
    "|---|--:|",
    "| 1 | 2 |",
    "",
    "---",
    "",
    "Setext",
    "======",
    "",
    "Last.",
].join("\n");

class MarkdownTest extends Form {

    moved  = [];
    picked   = [];
    followed = [];
    claim    = false;

    Form_Open() {
        Application.OnError = (message) => {
            failures.push(`uncaught: ${message}`);
        };
        Directory.Make(SCRATCH);

        this.document();
        this.markup();
        this.shapes();
        this.pictures();
        this.scrolling();
        this.selecting();
        this.linking();
        this.finding();
        this.exporting();
        this.theGuide();

        this.finish();
    }

    at(name) { return File.Join(SCRATCH, name); }

    /* The document drawn once, as the list of calls it took. `Save` measures at
     * the width it is given, so every assertion below knows the column. */
    drawn(width) {
        this.Doc.Save(this.at("frame.png"), width || 600, 1);
        return this.Doc.Canvas.Dump().split("\n");
    }

    /* The one call that drew a run of text containing this. */
    textLine(lines, has) {
        return lines.find((l) => l.startsWith("Text \"") && l.includes(has)) || "";
    }

    /* ------------------------------------------------------- the document */
    document() {
        eq("an empty document is its margins and nothing else",
           this.Doc.ContentHeight, 48);
        eq("and has no headings", this.Doc.Headings.length, 0);

        this.Doc.Text = SAMPLE;

        const heads = this.Doc.Headings;
        eq("every heading is found", heads.length, 3);
        eq("with its level", heads.map((h) => h.Level).join(), "1,2,1");
        eq("its words, without the emphasis", heads[0].Text, "Title");
        eq("and the anchor a link would use", heads[1].Id, "second");
        eq("the underlined kind is a heading too", heads[2].Text, "Setext");
        check("and they are in the order they appear",
              heads[0].Y < heads[1].Y && heads[1].Y < heads[2].Y,
              JSON.stringify(heads.map((h) => h.Y)));

        check("a document is taller than its margins", this.Doc.ContentHeight > 200,
              this.Doc.ContentHeight);

        /* The measure is against the column, so a narrow one is a taller
         * document: the same words, fewer of them to a line. `MaxWidth` is how
         * a host says so without resizing anything. */
        const wide = this.Doc.ContentHeight;
        this.Doc.MaxWidth = 260;
        const narrow = this.Doc.ContentHeight;

        check("a narrower column is a taller document", narrow > wide,
              `${narrow} against ${wide}`);

        /* And it is centred in the room there is, which is the whole reason to
         * cap it: 600 wide, a column of 260, so the text starts at 170. */
        const capped = this.drawn(600);
        check("a capped column is centred",
              capped.some((l) => l.includes("at (170,")),
              JSON.stringify(capped.filter((l) => l.startsWith("Text")).slice(0, 2)));
        this.Doc.MaxWidth = 0;

        /* `Text` is what is parsed; nothing reads the source twice. */
        eq("the text reads back as it was set", this.Doc.Text, SAMPLE);

        this.Doc.Text = "# Only\n\nOne line.";
        eq("and a new document replaces the old", this.Doc.Headings.length, 1);

        /* **An anchor is made of letters of any script, and it is unique.**
         * `\w` is ASCII: `Введение` slugged to "" and `Instalación` to
         * `instalacin`, and two headings called `Setup` shared one anchor, so
         * `ScrollTo` and a `#setup` link could only reach the first. */
        this.Doc.Text = "# Введение\n\n## Instalación\n\n## Setup\n\n## Setup\n\n" +
                        "> ## Setup\n\n## Hello, World! (v2)\n\n" +
                        "A long paragraph. ".repeat(400);
        eq("a heading in another script has an anchor",
           this.Doc.Headings[0].Id, "введение");
        eq("an accent is kept", this.Doc.Headings[1].Id, "instalación");
        eq("the same words twice are two anchors",
           this.Doc.Headings.slice(2, 5).map((h) => h.Id).join(), "setup,setup-1,setup-2");
        eq("and an ASCII heading slugs as it always did",
           this.Doc.Headings[5].Id, "hello-world-v2");
        this.Doc.Scroll = 0;
        check("ScrollTo reaches the second of two", this.Doc.ScrollTo("setup-1") &&
              this.Doc.Scroll > 0, this.Doc.Scroll);
        this.Doc.Text = SAMPLE;
    }

    /* ----------------------------------------------------------- markup
     *
     * What the runtime learned for this library: a paragraph is one call,
     * carrying its own runs. Every assertion here is a substring of a `Text`
     * line in the dump, which is the markup exactly as Pango was handed it.
     */
    markup() {
        const lines = this.drawn(600);
        const para  = this.textLine(lines, "A paragraph with");

        check("a paragraph is drawn as markup", para.endsWith("markup"), para);
        check("bold is bold", para.includes("<b>bold</b>"), para);
        check("italic is italic", para.includes("<i>italic</i>"), para);
        check("struck is struck", para.includes("<s>struck</s>"), para);
        check("a code span is set in the monospace",
              para.includes("<span font_family=\"Monospace\""), para);
        check("and a link is coloured and underlined",
              para.includes("underline=\"single\""), para);

        const second = this.textLine(lines, "Second paragraph");
        check("what a document says is escaped, not parsed",
              second.includes("a &lt; b &amp; c"), second);
        check("and an underscore inside a word is not emphasis",
              second.includes("snake_case"), second);

        /* One call and not one per run: the whole paragraph goes to Pango,
         * which is what makes the line breaks right where the font changes. */
        const runs = lines.filter((l) => l.includes("A paragraph with"));
        eq("a paragraph is one call", runs.length, 1);

        this.Doc.Text = "A \\*literal\\* asterisk, and *real* emphasis.";
        const escaped = this.textLine(this.drawn(600), "literal");
        check("a backslash escapes what Markdown would have eaten",
              escaped.includes("*literal*") && escaped.includes("<i>real</i>"), escaped);

        /* **The markup is kept per palette, and the key has to be the whole of
         * it.** It was the ink alone, so a `CodeFont` changed under the same
         * theme reused the markup it had and the code spans stayed in the
         * family the document was opened with. */
        this.Doc.Text = "A `code span` here.";
        check("a code span is set in the monospace",
              this.textLine(this.drawn(600), "code span").includes('font_family="Monospace"'));

        this.Doc.CodeFont = "Courier 10";
        check("and follows CodeFont when it changes",
              this.textLine(this.drawn(600), "code span").includes('font_family="Courier"'),
              this.textLine(this.drawn(600), "code span"));
        this.Doc.CodeFont = "";

        /* A hard break is the one newline a paragraph keeps, and the proof is
         * that it is taller than the same words without it. */
        this.Doc.Text = "one two";
        const flat = this.Doc.ContentHeight;
        this.Doc.Text = "one  \ntwo";
        check("two spaces at the end of a line break it",
              this.Doc.ContentHeight > flat, `${this.Doc.ContentHeight} against ${flat}`);

        this.Doc.Text = "one\ntwo";
        eq("and an ordinary newline is a space", this.Doc.ContentHeight, flat);

        /* **An underscore does not close inside a word**, the mirror of not
         * opening inside one: `_foo_bar` is literal in CommonMark, and was
         * `<i>foo</i>bar`. An asterisk keeps its intraword emphasis. */
        this.Doc.Text = "An _foo_bar here, and _real_ emphasis, and a*b*c.";
        const intra = this.textLine(this.drawn(600), "here");
        check("an underscore inside a word closes nothing",
              intra.includes("_foo_bar") && !intra.includes("<i>foo</i>"), intra);
        check("while one at a word's edge still does", intra.includes("<i>real</i>"), intra);
        check("and an asterisk still works inside a word", intra.includes("a<i>b</i>c"), intra);

        this.Doc.Text = SAMPLE;
    }

    /* --------------------------------------------------------- the blocks */
    shapes() {
        const lines = this.drawn(600);

        /* A code block is a panel and then plain text -- plain, because there
         * is nothing in a code block that markup would say. */
        const code = this.textLine(lines, "const a = 1;");
        check("a code block is drawn in the monospace",
              lines[lines.indexOf(code) - 2].startsWith("Font Monospace"), code);
        check("and not as markup", !code.endsWith("markup"), code);
        check("over a panel", lines.some((l) => l.startsWith("Color #f2f1f0")));

        check("an unordered list has its bullet", lines.some((l) => l.includes('"•"')));
        check("and a nested one changes glyph", lines.some((l) => l.includes('"◦"')));
        check("an ordered list starts where it says",
              lines.some((l) => l.includes('"7."')) && lines.some((l) => l.includes('"8."')));

        /* A quote is dimmed, which is a colour and not a font. */
        const quote = lines.indexOf(this.textLine(lines, "quoted"));
        check("a quote is dimmed", lines[quote - 1] === "Color #5c5c5c",
              lines[quote - 1]);

        /* The table's delimiter said `--:`, and that reaches the drawing as an
         * alignment rather than as a measurement done by hand. */
        const cell = this.textLine(lines, '"2"');
        check("a table column aligns where its delimiter says",
              cell.includes(" right"), cell);

        check("a thematic break is a rule", lines.some((l) => l.startsWith("LineTo (576,")));

        /* **A header row with nothing in it is not a header.** Every reference
         * page in this tree writes its member list as a table whose headings are
         * `| | |`, and a heading band drawn over each of them is an empty grey
         * strip per table. */
        this.Doc.Text = "| | |\n|---|---|\n| `Count` | how many |\n| `Index` | which one |";
        const bare = this.drawn(600);
        check("a table with no headings draws no heading band",
              !bare.some((l) => l.startsWith("Color #f2f1f0")), JSON.stringify(bare));
        check("and its first row is at the top of it",
              bare.some((l) => l.startsWith("Text ") && l.includes("Count")),
              JSON.stringify(bare.filter((l) => l.startsWith("Text"))));

        this.Doc.Text = "| a | b |\n|---|---|\n| 1 | 2 |";
        check("a table with headings still has one",
              this.drawn(600).some((l) => l.startsWith("Color #f2f1f0")));

        /* **A delimiter row has as many cells as the header**, or it is not
         * one: `a | b` over `---` is GFM's setext heading, and was a table of
         * two columns under a delimiter that declared one. */
        this.Doc.Text = "a | b\n---\n\ntext";
        eq("a one-cell delimiter under two cells makes a heading",
           this.Doc.Headings.map((h) => h.Text).join(), "a | b");

        /* **A tab is indentation to the next multiple of four.** Counted as
         * one column, the nested item was a sibling and drew a `•`. */
        this.Doc.Text = "-\tone\n\t- nested";
        const tabbed = this.drawn(600);
        check("a tab-indented item nests", tabbed.some((l) => l.includes('"◦"')),
              JSON.stringify(tabbed.filter((l) => l.startsWith("Text"))));
        this.Doc.Text = "```\n\tkept\n```";
        check("and a tab inside a fence is the code's",
              this.textLine(this.drawn(600), "kept").includes("\tkept"),
              this.textLine(this.drawn(600), "kept"));

        /* **A word in a code span is measured in the code font.** A monospace is
         * wider than the body face, so a column of member names -- which is what
         * every reference page is -- was given a floor it did not fit in and
         * `Background` came out hyphenated. */
        this.Doc.CodeFont = "Monospace 10";
        this.Doc.Text = "| | |\n|---|---|\n| `Background` | any CSS colour, and a " +
                        "long explanation after it so the table has to squeeze " +
                        "something somewhere to fit the column it is given |";

        const tight = this.textLine(this.drawn(420), "Background");
        const width = Number(new Regex("width (\\d+)").Match(tight).Group(1));
        const needs = Text.Width("Background", "Monospace 10");

        check("a column is never narrower than the code word in it",
              width >= needs, `${width} for a word of ${needs}: ${tight}`);
        this.Doc.CodeFont = "";

        /* Two levels of heading get a rule under them and the rest do not. */
        this.Doc.Text = "# One\n\n### Three\n\ntext";
        const rules = this.drawn(600).filter((l) => l.startsWith("Stroke")).length;
        eq("a rule under the top levels only", rules, 1);

        this.Doc.Text = SAMPLE;
    }

    /* ------------------------------------------------------------ pictures */
    pictures() {
        this.Doc.Path = File.Join(Application.Directory, "MarkdownTest.js");
        this.Doc.Text = "![a mark](mark.png)";

        const lines = this.drawn(600);
        const image = lines.find((l) => l.startsWith("Image "));

        check("a picture on a line of its own is drawn", !!image, JSON.stringify(lines));
        check("resolved against the document's own folder",
              image.includes("tests/markdown/mark.png"), image);

        /* Never enlarged: the mark is small and the column is not. */
        const height = this.Doc.ContentHeight;
        this.Doc.Save(this.at("wide.png"), 900, 1);
        eq("and never enlarged past its own size", this.Doc.ContentHeight, height);

        this.Doc.Text = "![nothing here](no-such-file.png)";
        const missing = this.drawn(600);
        check("a picture that is not there is a box and not a throw",
              missing.some((l) => l.startsWith("LineDash")), JSON.stringify(missing));
        check("with its alt text in it",
              missing.some((l) => l.includes("nothing here")));

        this.Doc.Path = "";
        this.Doc.Text = SAMPLE;
    }

    /* ----------------------------------------------------------- scrolling */
    scrolling() {
        this.Doc.Text = SAMPLE + "\n\n" + "A long paragraph. ".repeat(400);
        this.moved = [];

        eq("a document taller than its view can be scrolled",
           this.Doc.ScrollMax > 0, true);

        /* **An assignment says nothing**: a property setter must not raise an
         * event, since a `.form` declaring it would raise one before the host's
         * other controls exist. The reader's gestures and the verbs do. */
        this.Doc.Scroll = 100;
        eq("the scroll is where it was put", this.Doc.Scroll, 100);
        eq("and an assignment raises no Scroll", this.moved.length, 0);

        this.Doc.Canvas_KeyPress("Down");
        eq("a key that moves the view says so once", this.moved.length, 1);
        eq("with where it went", this.moved[0], this.Doc.Scroll);

        this.Doc.Canvas_KeyPress("Home");
        this.Doc.Canvas_KeyPress("Home");
        eq("a gesture that changes nothing says nothing", this.moved.length, 2);

        this.Doc.Scroll = -50;
        eq("before the beginning is the beginning", this.Doc.Scroll, 0);

        this.Doc.Scroll = 999999;
        eq("and past the end is the end", this.Doc.Scroll, this.Doc.ScrollMax);

        eq("End goes there", this.Doc.Canvas_KeyPress("End"), true);
        eq("Home comes back", (this.Doc.Canvas_KeyPress("Home"), this.Doc.Scroll), 0);
        eq("a key it does not know is not consumed",
           this.Doc.Canvas_KeyPress("F5"), false);

        eq("a wheel notch is consumed", this.Doc.Canvas_MouseWheel(0, 1), true);
        check("and it moved", this.Doc.Scroll > 0, this.Doc.Scroll);

        this.Doc.Scroll = 0;
        check("ScrollTo finds a heading by its anchor", this.Doc.ScrollTo("second"));
        check("and lands on it", this.Doc.Scroll > 0, this.Doc.Scroll);

        this.Doc.Scroll = 0;
        check("or by the words themselves", this.Doc.ScrollTo("Second"));
        eq("and answers when there is no such heading",
           this.Doc.ScrollTo("nothing of the sort"), false);

        /* A document that shrank under its own scroll must not be left showing
         * the blank below its last line. */
        this.Doc.Scroll = this.Doc.ScrollMax;
        this.Doc.Text   = "# Small\n\nOne line.";
        eq("a shorter document pulls the scroll back", this.Doc.Scroll, 0);
    }

    Doc_Scroll(y) { this.moved.push(y); }

    /* ----------------------------------------------------------- selecting
     *
     * The half a drawn document could not do until the text surface learned to
     * answer *where a character is*. Everything here is that pair of calls --
     * `Text.IndexAt` under the pointer, `Text.Bounds` behind the words.
     */
    selecting() {
        this.Doc.Text = "# Title\n\nA paragraph with **bold** and `code` in it.\n\n" +
                        "- one\n- two\n\nLast paragraph.";
        this.picked = [];

        /* A frame, not an export: `Canvas.Save` runs the ordinary draw, which
         * is the one that knows about a selection. */
        const frame = (name) => {
            this.Doc.Canvas.Save(this.at(name || "frame.png"), 420, 400);
            return this.Doc.Canvas.Dump().split("\n");
        };
        frame();

        eq("a new document has nothing selected", this.Doc.Selection, "");

        const runs = this.Doc._items.filter((it) => it.Key !== undefined);
        eq("every run of text can be selected and the markers cannot",
           runs.length, 5);
        eq("and a run holds the words and not the markup",
           runs[1].Plain, "A paragraph with bold and code in it.");

        check("the whole document is one verb", this.Doc.SelectAll());
        const all = this.Doc.Selection;
        check("which takes the headings and the paragraphs",
              all.startsWith("Title\nA paragraph with bold") && all.endsWith("Last paragraph."),
              JSON.stringify(all));
        check("and none of the bullets", !all.includes("\u2022"), JSON.stringify(all));
        eq("selecting says so, once", this.picked.length, 1);
        eq("with the text it selected", this.picked[0], all);

        /* The highlight is painted behind the words, in the selection's own
         * colour -- and it is `Text.Bounds` that says where, which is why it
         * lands on the wrap and not on a guess. */
        const lit = frame("lit.png");
        check("a selection is painted", lit.some((l) => l.startsWith("Color rgba(53,132,228")),
              JSON.stringify(lit.slice(0, 6)));
        check("behind the text and not over it",
              lit.indexOf(lit.find((l) => l.startsWith("Color rgba(53,132,228"))) <
              lit.indexOf(lit.find((l) => l.startsWith("Text \"Title"))));

        /* An export is the document and not somebody's pointer. */
        this.Doc.Save(this.at("clean.png"), 420, 1);
        const clean = this.Doc.Canvas.Dump().split("\n");
        check("an export carries no selection",
              !clean.some((l) => l.startsWith("Color rgba(53,132,228")));

        /* **The offsets survive a re-measure**, which is the whole reason a
         * selection is a pair of them and not a pair of points. */
        this.Doc.MaxWidth = 240;
        this.Doc.Canvas.Save(this.at("narrow.png"), 420, 400);
        eq("and it survives the column changing under it", this.Doc.Selection, all);
        this.Doc.MaxWidth = 0;

        check("clearing it says so", this.Doc.Deselect());
        eq("and it is empty", this.Doc.Selection, "");
        eq("which was announced", this.picked.length, 2);
        eq("clearing nothing is nothing", this.Doc.Deselect(), false);

        /* A drag: down, move, up. `Select` is the mouse-up and not the move --
         * a host enabling a Copy button does not want sixty a second.
         *
         * **Measured at the width the handlers will use** and not at the one the
         * frames above were drawn at: a hit test measures if it has to, and the
         * items are rebuilt at every width, so reading a run's `X` from one
         * layout and clicking it in another lands somewhere else entirely. */
        this.Doc.ContentHeight;
        const para = this.Doc._items.find((it) => it.Key === 1);
        const y    = para.Y + 4 - this.Doc.Scroll;

        this.picked = [];
        this.Doc.Canvas_MouseDown(para.X + 2, y, 1);
        this.Doc.Canvas_MouseMove(para.X + 60, y);
        eq("a drag in flight says nothing", this.picked.length, 0);
        check("but it is already selected", this.Doc.Selection.length > 0,
              JSON.stringify(this.Doc.Selection));
        this.Doc.Canvas_MouseUp();
        eq("and the mouse-up says it once", this.picked.length, 1);
        check("what the drag covered is the start of that paragraph",
              para.Plain.startsWith(this.Doc.Selection.slice(0, 4)),
              JSON.stringify(this.Doc.Selection));

        /* Backwards is the same selection: the anchor may be after the head. */
        const forwards = this.Doc.Selection;
        this.Doc.Canvas_MouseDown(para.X + 60, y, 1);
        this.Doc.Canvas_MouseMove(para.X + 2, y);
        this.Doc.Canvas_MouseUp();
        eq("dragging backwards selects the same words", this.Doc.Selection, forwards);

        /* A double click is a word, and a click on its own clears. */
        this.Doc.Canvas_DblClick(para.X + 20, y, 1);
        const word = this.Doc.Selection;
        check("a double click takes a word",
              word.length > 1 && !word.includes(" ") &&
              para.Plain.includes(word), JSON.stringify(word));

        this.picked = [];
        this.Doc.Canvas_MouseDown(para.X + 2, y, 1);
        this.Doc.Canvas_MouseUp(para.X + 2, y, 1);
        eq("a click clears it", this.Doc.Selection, "");
        /* **Once**: the clearing is silent and the mouse-up is what speaks, or a
         * host enabling a Copy button on `Select` sees it flicker. */
        eq("and says so exactly once", this.picked.length, 1);
        eq("with nothing in it", this.picked[0], "");

        /* The right button leaves it alone: what it opens is a menu about it. */
        this.Doc.SelectAll();
        this.Doc.Canvas_MouseDown(para.X + 2, y, 3);
        this.Doc.Canvas_MouseUp();
        eq("the right button keeps the selection", this.Doc.Selection, all);

        /* The keys. Ctrl+C answers whether there was anything to copy, which is
         * the whole of what a test without a clipboard server can ask. */
        check("Ctrl+C copies", this.Doc.Canvas_KeyPress("c", true));
        check("Ctrl+A selects everything", this.Doc.Canvas_KeyPress("a", true));
        eq("and Escape clears it", this.Doc.Canvas_KeyPress("Escape"), true);
        eq("Ctrl+C with nothing selected copies nothing",
           this.Doc.Canvas_KeyPress("c", true), false);
        eq("and Escape with nothing selected is not consumed",
           this.Doc.Canvas_KeyPress("Escape"), false);

        /* A code block is a run of text like any other -- it is the one whose
         * item carries plain text and no markup at all, so it is the one that
         * would have been left out by a selection that assumed there was. */
        this.Doc.Text = "Before.\n\n```js\nconst a = 1;\n```\n\nAfter.";
        this.Doc.ContentHeight;
        this.Doc.SelectAll();
        eq("a code block is selected with the rest",
           this.Doc.Selection, "Before.\nconst a = 1;\nAfter.");

        const inside = this.Doc._items.find((it) => it.Plain === "const a = 1;");
        this.Doc.select({ Key: inside.Key, At: 6 }, { Key: inside.Key, At: 7 });
        eq("and a range inside it is its own characters", this.Doc.Selection, "a");

        /* A new document cannot keep the old one's selection. */
        this.Doc.SelectAll();
        this.Doc.Text = "Something else entirely.";
        eq("a new document starts with nothing selected", this.Doc.Selection, "");
    }

    Doc_Select(text) { this.picked.push(text); }

    /* -------------------------------------------------------------- links
     *
     * The other half of *where a character is*: a click lands on a rectangle,
     * the rectangle belongs to a range of characters, and the range was written
     * down when the markup was built. Nothing here measures anything twice.
     */
    linking() {
        this.Doc.Text = "# A heading\n\n" +
                        "See [the guide](g.md) and [a section](#a-heading), " +
                        "plus <https://auto.example>.\n\n" +
                        "A *[nested](n.md)* link.";
        this.Doc.ContentHeight;
        this.followed = [];
        this.claim    = false;

        const para = this.Doc._items.find((it) => it.Key === 1);
        eq("every link in a paragraph is found", para.Links.length, 3);
        eq("with the address as it was written", para.Links[0].Href, "g.md");
        eq("an autolink is a link", para.Links[2].Href, "https://auto.example");
        eq("and the words are the words and not the brackets",
           para.Plain, "See the guide and a section, plus https://auto.example.");

        const nested = this.Doc._items.find((it) => it.Key === 2);
        eq("a link inside emphasis keeps its place", nested.Links.length, 1);
        eq("and points where it said",
           nested.Plain.slice(nested.Links[0].From, nested.Links[0].To), "nested");

        /* A click on one: down and up in the same place. */
        const boxes = this.Doc.linkBoxes(para);
        const spot  = (n) => ({ X: para.X + boxes[n].Boxes[0].X + 4,
                                Y: para.Y + boxes[n].Boxes[0].Y + 4 - this.Doc.Scroll });
        const click = (at) => {
            this.Doc.Canvas_MouseDown(at.X, at.Y, 1);
            this.Doc.Canvas_MouseUp(at.X, at.Y, 1);
        };

        click(spot(0));
        eq("a click on a link follows it", this.followed.length, 1);
        eq("with its address", this.followed[0][0], "g.md");
        eq("and the words that were clicked", this.followed[0][1], "the guide");

        /* Past the end of the line there is no link, however close the last one
         * is: the test is the rectangle the words occupy and not the character
         * the pointer is nearest to. */
        this.followed = [];
        click({ X: para.X + para.Width - 2, Y: spot(0).Y });
        eq("a click past the words follows nothing", this.followed.length, 0);

        /* A drag is not a click, even a short one: following a link on the way
         * down would take the document out from under somebody selecting it. */
        this.Doc.Canvas_MouseDown(spot(0).X, spot(0).Y, 1);
        this.Doc.Canvas_MouseMove(spot(0).X + 30, spot(0).Y);
        this.Doc.Canvas_MouseUp(spot(0).X + 30, spot(0).Y, 1);
        eq("a drag that selected something follows nothing", this.followed.length, 0);
        check("it selected instead", this.Doc.Selection.length > 0, this.Doc.Selection);
        this.Doc.Deselect();

        /* An anchor nobody claims scrolls the document; a handler that answers
         * `true` has dealt with it and nothing else happens. */
        this.Doc.Text = "# Top\n\nGo to [the end](#the-end).\n\n" +
                        "Filler.\n\n".repeat(80) + "## The end\n\nHere.";
        this.Doc.ContentHeight;

        const jump = this.Doc._items.find((it) => it.Links && it.Links.length);
        const at   = this.Doc.linkBoxes(jump).at(0).Boxes[0];
        const on   = { X: jump.X + at.X + 4, Y: jump.Y + at.Y + 4 - this.Doc.Scroll };

        this.followed = [];
        click(on);
        eq("an anchor is reported like any other link", this.followed.length, 1);
        check("and scrolls the document when nobody claims it",
              this.Doc.Scroll > 0, this.Doc.Scroll);

        this.Doc.Scroll = 0;
        this.claim = true;
        click(on);
        eq("a handler that answers true keeps it", this.Doc.Scroll, 0);
        this.claim = false;

        /* The pointer says what a click would do, which is the other half of a
         * link being clickable at all. */
        this.Doc.pointer(on.X, on.Y);
        eq("the pointer is a hand over a link", this.Doc.Canvas.Cursor, "Hand");
        this.Doc.pointer(jump.X + jump.Width - 2, on.Y);
        eq("and a text cursor over the words around it",
           this.Doc.Canvas.Cursor, "Text");
        /* Left of the column, which is off the text however the paragraphs
         * wrapped: 400 pixels down from the link lands in the filler on one
         * machine and between two paragraphs on another, and that is a font
         * measurement rather than a question about the pointer. */
        this.Doc.pointer(jump.X - 20, on.Y);
        eq("and nothing in particular off the text", this.Doc.Canvas.Cursor, "Auto");
    }

    /* ---------------------------------------------------------- finding
     *
     * A search with a selection on the end of it, which is how the IDE opens a
     * page at a member.
     */
    finding() {
        this.Doc.Text = "# One\n\nA paragraph naming `Ellipsize` once.\n\n" +
                        "Filler.\n\n".repeat(60) +
                        "## Two\n\nAnd another that names Ellipsize again.";
        this.Doc.ContentHeight;
        this.picked = [];

        check("a text that is there is found", this.Doc.Find("Ellipsize"));
        eq("and selected", this.Doc.Selection, "Ellipsize");
        eq("which was announced", this.picked.length, 1);

        const first = this.Doc.Scroll;
        check("the next one is found too", this.Doc.FindNext());
        check("and it is further down", this.Doc.Scroll > first,
              `${this.Doc.Scroll} after ${first}`);
        eq("still the same words", this.Doc.Selection, "Ellipsize");

        check("and it wraps round to the first", this.Doc.FindNext());
        eq("which is where it started", this.Doc.Scroll, first);

        check("case is folded", this.Doc.Find("ELLIPSIZE"));
        eq("and what is selected is what the document says",
           this.Doc.Selection, "Ellipsize");

        eq("a text that is not there is not found", this.Doc.Find("Nonesuch"), false);
        eq("and finds nothing next either", this.Doc.FindNext(), false);

        /* Text already on screen is left where it is: a find that jumps the page
         * when it did not have to is a find that loses the reader. */
        this.Doc.Scroll = 0;
        this.Doc.Find("paragraph naming");
        eq("a match already in view does not move the page", this.Doc.Scroll, 0);
    }

    Doc_Link(href, text) {
        this.followed.push([href, text]);
        return this.claim;
    }

    /* ----------------------------------------------------------- exporting */
    exporting() {
        this.Doc.Text = SAMPLE;

        const png = this.at("one.png");
        this.Doc.Save(png, 600, 1);
        check("a document goes out as a picture", File.Exists(png));

        const small = File.Info(png).Size;
        this.Doc.Text = SAMPLE + "\n\n" + "More words. ".repeat(200);
        this.Doc.Save(this.at("two.png"), 600, 1);
        check("and a longer one is a bigger file",
              File.Info(this.at("two.png")).Size > small);

        /* The export measures at the width it was given and not at the width of
         * the window -- which the first version of this did, because clamping
         * the scroll asked a getter that measured. */
        this.Doc.Save(this.at("narrow.png"), 300, 1);
        const narrow = this.Doc.Canvas.Dump().split("\n")
                           .find((l) => l.startsWith("Rectangle (0,0)"));
        check("an export is the size it was asked for", narrow.includes("300x"), narrow);

        const pdf = this.at("doc.pdf");
        const pages = this.Doc.SavePdf(pdf);
        check("and out as a document", File.Exists(pdf));
        check("of more than one page", pages > 1, pages);

        /* Margins that cover the whole sheet leave no band to put a page in:
         * the pagination never advanced, and the export hung for good. */
        const hadMargins = this.Doc.Margins;
        this.Doc.Margins = 421;
        throws("margins that leave no room on the sheet are refused, not a hang",
               () => this.Doc.SavePdf(this.at("full.pdf")));
        this.Doc.Margins = { Top: 421, Bottom: 421 };
        throws("and so are a top and a bottom that meet",
               () => this.Doc.SavePdf(this.at("full.pdf")));
        throws("and a side that is not a number",
               () => { this.Doc.Margins = { Top: "x" }; });
        throws("nor a finite one", () => { this.Doc.Margins = { Left: NaN }; });
        this.Doc.Margins = hadMargins;
        eq("a refused side leaves the margins as they were", this.Doc.Margins, hadMargins);

        const small5 = this.Doc.SavePdf(this.at("a5.pdf"), "A5");
        check("a smaller sheet takes more of them", small5 > pages, `${small5} against ${pages}`);
        throws("and a sheet that is not one is refused",
               () => this.Doc.SavePdf(this.at("no.pdf"), "Foolscap"));

        /*
         * **And onto paper, which is `Printer`'s.** The viewer works out where
         * the sheets cut -- the same pagination `SavePdf` uses -- and
         * `Canvas_DrawPage` turns a sheet number into the band that goes on it,
         * so `Printer` draws this document without the viewer intermediating.
         * `ToFile` is the road a test can take; `Send` opens the dialog.
         */
        const printed = this.at("printed.pdf");
        const wrote = Printer.ToFile(this.Doc.Canvas, printed,
                                     { Pages: pages, Paper: "A4" });
        eq("Printer writes the document with no dialog", File.Info(printed).Type,
           "application/pdf");
        eq("of the pages SavePdf would have written", wrote, pages);

        /* One page of it, which `pages > 1` above makes a real range whatever
         * the sample grows into. */
        const ranged = this.at("printed-range.pdf");
        eq("a range writes exactly its pages",
           Printer.ToFile(this.Doc.Canvas, ranged,
                          { Pages: pages, From: 1, To: 1 }), 1);
        check("in a smaller file",
              File.Info(ranged).Size < File.Info(printed).Size,
              `${File.Info(ranged).Size} against ${File.Info(printed).Size}`);

        /*
         * **The paper the dialog settles on decides how many sheets there are.**
         * A viewer laid out for A4 is more sheets on A5, and the count declared
         * when the print began was A4's: without `Canvas_Paginate` the
         * operation printed that many and dropped the rest -- four declared,
         * six needed, four printed, silently. Measured, and this is the
         * assertion that keeps it measured.
         */
        const a5file = this.at("printed-a5.pdf");
        const onA5   = Printer.ToFile(this.Doc.Canvas, a5file,
                                      { Pages: pages, Paper: "A5" });
        check("a smaller paper prints more sheets than were declared",
              onA5 > pages, `${onA5} against the ${pages} declared`);
        /* At least what the whole sheet takes, because what a printer gives a
         * page is the sheet less its own margins -- never more. How many more
         * is the printer's, so the assertion is the direction and not a
         * number. */
        const wholeA5 = this.Doc.SavePdf(this.at("len-a5.pdf"), "A5");
        check("and no fewer than the whole sheet would take",
              onA5 >= wholeA5, `${onA5} against ${wholeA5}`);

        /*
         * **The canvas on its own**, which is the road that skips both of this
         * viewer's verbs: `SavePdf` here is the `DrawingArea`'s and not the
         * component's, so nobody has paginated and `Canvas_DrawPage` is the
         * only thing standing between that and a sheet of the *screen's* band.
         *
         * Asserted because the suite reached it through neither road and the
         * line looked like dead code: every other path -- `Markdown.SavePdf`,
         * and `Printer` through `Canvas_Paginate` -- paginates first. It is not
         * dead, it is the one place nothing else covers.
         */
        const bare = this.at("bare-canvas.pdf");
        this.Doc.Canvas.SavePdf(bare, 595, 842, 3);
        eq("the canvas on its own still writes a document",
           File.Info(bare).Type, "application/pdf");
        check("and it is not empty", File.Info(bare).Size > 0,
              String(File.Info(bare).Size));

        /* `Send` is the viewer's own line to the dialog; what is assertable
         * without one is that it refuses before anything opens. */
        throws("a sheet that is not one is refused",
               () => this.Doc.Send({ Paper: "Foolscap" }, () => {}));
        throws("and a setup that is not an object",
               () => this.Doc.Send(42, () => {}));
        throws("and no copies", () => this.Doc.Send({ Copies: 0 }, () => {}));
        throws("and a Send with nobody to tell", () => this.Doc.Send({}));

        /*
         * **No block is cut across a page boundary.** The pagination is the one
         * place a viewer and `lib/report` do the same work, and it is asserted
         * on the bands themselves: every break has to fall between items, not
         * through one.
         */
        this.Doc.Save(this.at("paper.png"), 595, 1);
        const bands = this.Doc.pageBreaks(842, { Top: 24, Right: 24, Bottom: 24, Left: 24 });

        check("the pages cover the document",
              bands[0].From === 0 && bands[bands.length - 1].To >= this.Doc.ContentHeight,
              JSON.stringify(bands));
        check("each page starts where the last one ended",
              bands.every((b, i) => i === 0 || b.From === bands[i - 1].To));

        const through = [];
        for (const b of bands)
            for (const it of this.Doc._items)
                if (it.Y < b.To && it.Y + (it.Height || 0) > b.To && it.Y > b.From)
                    through.push(`${it.Kind} at ${it.Y}`);
        eq("and none of them cuts a block in half", through.join(), "");
    }

    /* ------------------------------------------------------------ the guide
     *
     * The example's own document, parsed and drawn here: a page that is the
     * library's shop window should not be the one thing nothing reads.
     */
    theGuide() {
        const guide = File.Join(File.Directory(File.Directory(Application.Directory)),
                                "examples/markdown/Guide.md");
        if (!File.Exists(guide)) {
            failures.push(`the example's Guide.md is not at ${guide}`);
            return;
        }
        this.Doc.Load(guide);

        eq("the guide came from where it was loaded", this.Doc.Path, guide);
        check("it has its headings", this.Doc.Headings.length >= 8,
              this.Doc.Headings.length);
        check("and a real height", this.Doc.ContentHeight > 1000, this.Doc.ContentHeight);

        const lines = this.drawn(720);
        check("its logo is drawn from beside it",
              lines.some((l) => l.startsWith("Image ") && l.includes("examples/markdown/logo.png")),
              JSON.stringify(lines.filter((l) => l.startsWith("Image"))));
        check("and its missing picture is a box",
              lines.some((l) => l.includes("a picture that is not there")));
    }

    /* --------------------------------------------------------------- report */
    finish() {
        try {
            for (const name of Directory.List(SCRATCH))
                try { File.Delete(File.Join(SCRATCH, name)); } catch (e) { /* dirs stay */ }
            File.Delete(SCRATCH);
        } catch (e) { /* nothing was written: nothing to sweep */ }

        Application.OnError = null;

        print("");
        for (const f of failures) print(`  FAIL  ${f}`);
        print(`markdown: ${passed} passed, ${failures.length} failed`);
        Application.Quit(failures.length ? 1 : 0);
    }
}
