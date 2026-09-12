/*
 * A Markdown file, shown as the document it is.
 *
 * Every project here has a `README.md` and the IDE could not show it: `.md` was
 * not among the extensions the tree listed, so the one file a project writes
 * *for a person to read* was the one file the IDE pretended was not there. Now
 * it is listed, it opens like anything else, and what opens is the document --
 * drawn by `lib/markdown`, the library that already does this.
 *
 * **A document tab is an ordinary code tab with a preview in front of it**, and
 * that is the whole design. The tab still owns a `SourceEditor` holding the
 * file's text, so everything `TabSet` does about a tab -- the modified flag,
 * saving, reloading when the file changes on disk, the find bar, the session,
 * the recovery of unsaved text -- keeps working with nothing added to it. What
 * this class adds is a bar with a *Source* toggle and a `Markdown` beside the
 * editor, and which of the two is on screen.
 *
 * A viewer that could not edit would be the wrong answer here: the IDE would be
 * listing a file of the project and refusing to let anybody fix a typo in it.
 * So the preview is what a `.md` opens on, and the toggle is one click away.
 *
 * **What a link does is the IDE's decision**, not the library's -- see `follow`.
 * A `.md` beside this one opens as a tab, which makes a project's documentation
 * browsable in the IDE the way it is on a forge; a `#anchor` needs nothing,
 * because the component scrolls to it when nobody claims it.
 */
"use strict";

Namespace("Ide");

/* The measure of the text column. A document that fills a maximised window is a
 * line of ninety words; the editor beside it has the same problem and solves it
 * with a monospace and a shorter line. */
const COLUMN = 760;

/* The gutter around it, in pixels: a page of prose is not flush against the
 * tab strip. */
const MARGINS = 28;

Ide.Document = class Document {

    /*
     * Builds the page: the bar, the rendered document, and the editor the tab
     * already made -- in that order, because the editor is what the toggle
     * swaps in and it starts hidden.
     */
    constructor(ide, page, editor, path) {
        this.ide    = ide;
        this.editor = editor;
        this.path   = path;
        this.shown  = null;              /* what the preview last rendered */

        const bar = new Panel();
        bar.Arrangement = "Horizontal";
        bar.Height      = 34;
        bar.Spacing     = 6;
        bar.Style       = "toolbar";

        /* Named like every other per-tab widget -- events dispatch by name and
         * only the page on screen has any, so `DocSource_Click` is whichever
         * document is showing. `MainForm` looks the tab up rather than the
         * widget. */
        const toggle = new ToggleButton();
        toggle.Name    = "DocSource";
        toggle.Text    = Locale.Text("Source");
        toggle.Tooltip = Locale.Text("Edit the text this page is written in");
        toggle.Height  = 26;
        toggle.Width   = 100;
        toggle.Style   = "flat";
        bar.Add(toggle);

        const doc = new Markdown();
        doc.Name     = "Doc";
        doc.Expand   = true;
        doc.MaxWidth = COLUMN;
        doc.Margins  = MARGINS;
        /*
         * **A stretched control asks for its floor and not for the size it was
         * drawn at**, and a component brings a drawn size with it: `Markdown`'s
         * own `.form` says 480x640, which is where a designer would place it and
         * is a 640px floor under the editor pane here. With both axes filling,
         * the request is `MinWidth`/`MinHeight` -- nothing -- so the console
         * divider moves as far as it ever did. Measured: without this the
         * divider under the editor stopped 238px short of where the session had
         * left it.
         */
        doc.HAlign   = "Fill";
        doc.VAlign   = "Fill";
        /* Where it came from, so `![](images/a.png)` finds the picture beside
         * the file and a link knows what it is relative to. */
        doc.Path     = path;

        page.Add(bar);
        page.Add(doc);
        page.Add(editor);

        this.bar    = bar;
        this.toggle = toggle;
        this.doc    = doc;

        this.showSource(false);
    }

    /* The editor or the document, and never both. Coming back to the document
     * re-renders it, so the preview is of what has been typed and not of what
     * was on disk when the tab opened. */
    showSource(on) {
        this.editor.Visible = on;
        this.doc.Visible    = !on;
        if (this.toggle.Active !== on) this.toggle.Active = on;

        if (!on) this.refresh();
    }

    editing() { return !!this.editor.Visible; }

    /*
     * The text into the document, when it is not already there.
     *
     * Assigning `Text` re-parses and re-measures, which on a long file is
     * milliseconds -- worth skipping on every tab switch, which is what the
     * comparison is for, and not worth any machinery beyond it.
     */
    refresh() {
        const text = this.editor.Text;
        if (text === this.shown) return;

        this.doc.Text = text;
        this.shown    = text;
    }

    /*
     * A link was clicked, and where it goes is this application's decision.
     *
     * A `#anchor` never reaches here -- the component scrolls to it when nobody
     * claims it, which is what makes a table of contents in a README work with
     * no code at all. What is left is: another file of this project, which opens
     * the way clicking it in the tree would; a file that exists but is not one
     * the IDE opens, which goes to the desktop; and an address, which is nobody
     * here -- a URI wants a browser, and the runtime hands one over through a
     * `LinkButton` and nowhere else. Saying so in the log beats a click that
     * looks broken.
     */
    follow(href, text) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
            this.ide.log(`${text}: ${href}\n`);
            return true;
        }

        /* Relative to the document and then made relative to the project, which
         * is the name every other part of the IDE calls a file by. */
        const target = File.Absolute(File.Join(File.Directory(this.path),
                                               href.replace(/#.*$/, "")));
        if (!File.Exists(target)) {
            this.ide.log(`${text}: ${href} is not here\n`);
            return true;
        }

        /* Inside the project it has a name -- the one the tree calls it by --
         * and that is what a tab is opened with. Outside it there is no name
         * and no tab: the IDE opens one project at a time. */
        const root = this.ide.project ? File.Absolute(this.ide.project) : "";
        const name = root && target.startsWith(`${root}/`)
                        ? target.slice(root.length + 1) : "";

        if (name && Ide.TabSet.opensInTab(name) && this.ide.opensAsText(name)) {
            this.ide.openInTab(name);
            return true;
        }

        /* A picture, an archive, a file of somebody else's: the desktop knows
         * what opens it and the IDE does not. */
        try {
            File.Open(target);
        } catch (e) {
            this.ide.log(`Cannot open ${href}: ${e.message}\n`);
        }
        return true;
    }
};
