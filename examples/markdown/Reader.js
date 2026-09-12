/*
 * A Markdown reader: the document on the right, its headings on the left.
 *
 * The `Markdown` in `lib/markdown` is the whole of the parsing, the layout and
 * the drawing; this form is what using it looks like, and it is forty lines
 * because everything a reader needs is already a property:
 *
 *   Load(path)       the file, and where it came from, so its pictures resolve
 *   Headings         what a table of contents is built from
 *   ScrollTo(id)     what clicking one does
 *   Selection/Copy() what the reader dragged over, and onto the clipboard
 *   Link(href, text) a click on a link, for this form to decide about
 *   SavePdf(path)    the document as a document, not as a screenshot
 *
 * **`MaxWidth` is the one property worth arguing about.** A document that fills
 * a maximised window is a line of ninety words, which nobody reads; the column
 * is capped at 720 pixels in the `.form` and centred in whatever room there is.
 * That is a decision about *reading*, and it belongs in the form the same way a
 * font does.
 *
 * Run it with no arguments and it shows the guide it ships with; pass a `.md` on
 * the command line, press the button, or **drop a file on the window**
 * (`AcceptFiles` in the `.form`, `Form_FileDrop` below), and it shows that one.
 *
 * **Links browse.** A `.md` beside the one that is open replaces it, anything
 * else that is a real file goes to the desktop, and a `#anchor` needs no handler
 * at all -- the component scrolls to it when nobody claims it. A web address is
 * the one thing this cannot do anything with: `File.Open` is for files, and
 * handing a URI to the desktop is a `LinkButton`'s job.
 */
"use strict";

class Reader extends Form {

    Form_Open() {
        const given = Application.Arguments[0];
        this.show(given && File.Exists(given)
                    ? given : File.Join(Application.Directory, "Guide.md"));
    }

    /* One document, and the contents beside it. Everything else on this form is
     * a consequence of these four lines. */
    show(path) {
        this.Doc.Load(path);
        this.LblWhere.Text = path;
        this.Text          = File.Name(path);

        this.Contents.Clear();
        /* Indented by level, which is the whole of the hierarchy a contents list
         * needs -- a `TreeView` here would be a tree nobody collapses. */
        for (const h of this.Doc.Headings)
            this.Contents.Add(`${"    ".repeat(Math.max(0, h.Level - 1))}${h.Text}`);
    }

    /*
     * A link was clicked, and what to do about it is **this form's** decision.
     *
     * The component reports and does not act: it has no idea whether this
     * application browses documents, opens them in an editor or refuses to
     * leave the page. Answering `true` says it has been dealt with; answering
     * nothing leaves it, and a `#anchor` that nobody claims scrolls the
     * document on its own -- which is why there is no case for one here.
     */
    Doc_Link(href, text) {
        const beside = File.Join(File.Directory(this.Doc.Path), href);

        if (File.Extension(href).toLowerCase() === "md" && File.Exists(beside)) {
            this.show(beside);                 /* the next document, in place */
            return true;
        }
        if (!href.includes("://") && File.Exists(beside)) {
            File.Open(beside);                 /* whatever the desktop opens it with */
            return true;
        }

        /* A web address has no verb here: `File.Open` is for files, and handing
         * a URI to the desktop is a `LinkButton`'s job. Saying so beats a click
         * that looks broken. */
        this.LblWhere.Text = `${text} -> ${href}`;
        return true;
    }

    /* The selection, as a button.
     *
     * `Select` arrives when a drag ends and not while it is moving, which is
     * what makes this an ordinary handler and not a throttle: the button is
     * enabled once per selection, and `Copy()` is the same verb Ctrl+C runs. */
    Doc_Select(text) {
        this.BtnCopy.Enabled = !!text;
        this.LblWhere.Text   = text ? `${text.length} characters selected`
                                    : this.Doc.Path;
    }

    BtnCopy_Click() { this.Doc.Copy(); }

    Contents_Select() {
        const at = this.Doc.Headings[this.Contents.Index];
        if (at) this.Doc.ScrollTo(at.Id);
    }

    BtnOpen_Click() {
        Dialog.OpenFile("Open a document",
                        { Filters: [["Markdown", "*.md"], ["Every file", "*"]] },
                        /* Not called when the user cancels, which is why there
                         * is nothing to test for here. */
                        (path) => this.show(path));
    }

    /* The document as a document. `SavePdf` answers how many pages it wrote,
     * which is the only interesting thing to say about it afterwards. */
    BtnPdf_Click() {
        Dialog.SaveFile("Export as PDF", { Name: `${File.BaseName(this.Doc.Path)}.pdf` },
            (path) => {
                const pages = this.Doc.SavePdf(path);
                this.LblWhere.Text = `${pages} page${pages === 1 ? "" : "s"} to ${path}`;
            });
    }

    Form_FileDrop(paths) {
        const md = paths.find((p) => File.Extension(p).toLowerCase() === "md");
        if (md) this.show(md);
    }
}
