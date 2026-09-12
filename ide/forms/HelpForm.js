/*
 * The reference, in the IDE.
 *
 * `docs/reference/` is one page per class, per global and per component the
 * shipped libraries publish, written for the person at this window — and the IDE
 * can already draw a Markdown document, so the help is not a viewer somebody has
 * to write: it is that library pointed at those files.
 *
 * **A window of its own and not a tab.** A tab belongs to a file of the *project*
 * — it is watched, saved and remembered in the session — and a page of the
 * reference is none of those things: it is the manual, open beside the work, and
 * it stays open while somebody switches files. Qt Creator and Delphi both put
 * help in its own place for the same reason.
 *
 * What F1 does is `MainForm`'s: this form is told a page and, when there is one,
 * a member to land on. Everything else here is what makes the reference
 * *browsable* — the tree of pages, the links between them, a find box, and a
 * back button, which is the one thing a reader misses immediately.
 */
"use strict";

/* Where the pages are, in the order to look.
 *
 * Two hops from the IDE's own directory and one from the binary, which is the
 * argument `lib_candidates` makes in the runtime applied here: `bin/` and
 * `share/` move together under a prefix and under a packager's DESTDIR, where a
 * path baked in at configure time does not. In the source tree the first
 * candidate is `<repo>/docs/reference`; installed, the IDE lives in
 * `share/bintana/ide` and the documents in `share/doc/bintana/docs`.
 */
function candidates() {
    const ide = Application.Directory;
    const bin = File.Directory(Application.Executable);

    return [
        /* the IDE running from the source tree: <repo>/ide -> <repo>/docs */
        File.Join(File.Directory(ide), "docs", "reference"),
        /* one hop from the binary, which is the same tree from anywhere else in
         * it: <repo>/build/bintana -> <repo>/docs. It is what makes the help
         * findable from a project that is not the IDE, and from the suite */
        File.Join(File.Directory(bin), "docs", "reference"),
        /* installed: share/bintana/ide -> share/doc/bintana/docs */
        File.Join(File.Directory(File.Directory(ide)), "doc", "bintana", "docs", "reference"),
        File.Join(File.Directory(bin), "share", "doc", "bintana", "docs", "reference"),
        "/usr/share/doc/bintana/docs/reference",
    ];
}

/* The three folders, in the order the tree shows them. */
const SECTIONS = [
    { key: "widgets",   text: "Controls" },
    { key: "globals",   text: "Globals" },
    { key: "libraries", text: "Libraries" },
];

class HelpForm extends Form {

    /*
     * The one window, kept.
     *
     * `HideOnClose` in the `.form` is the other half: a closed form's window is
     * destroyed, so a help window that was shut and asked for again would come
     * back 0x0. Closed and reopened, this one is the same window with the same
     * page in it.
     */
    static open(page, member) {
        if (!HelpForm.window) HelpForm.window = new HelpForm();

        const help = HelpForm.window;
        help.Show();
        if (page) help.go(page, member);
        return help;
    }

    /* Where the reference is on this machine, or `""`. */
    static root() {
        for (const at of candidates())
            if (File.IsDir(at)) return at;
        return "";
    }

    /* The file a name belongs to: `TableView`, `File`, `Chart` — or `""`.
     * Answered by looking, because which folder a name is in is a fact about the
     * directory and not a list worth keeping here. */
    static pageFor(name) {
        const root = HelpForm.root();
        if (!root || !name) return "";

        for (const section of SECTIONS) {
            const path = File.Join(root, section.key, `${name}.md`);
            if (File.Exists(path)) return path;
        }
        return "";
    }

    Form_Open() {
        this.history = [];
        this.root    = HelpForm.root();

        if (!this.root) {
            this.LblWhere.Text = Locale.Text("The reference is not installed beside this build.");
            return;
        }
        this.fill();
        this.go(File.Join(this.root, "README.md"));
    }

    /* The tree: a node per section, a node per page. The key is the path, so
     * choosing one needs no lookup at all. */
    fill() {
        this.Pages.Clear();
        this.byKey = {};

        for (const section of SECTIONS) {
            const dir = File.Join(this.root, section.key);
            if (!File.IsDir(dir)) continue;

            this.Pages.Add(`cat:${section.key}`, Locale.Text(section.text), "",
                           "folder-documents-symbolic");

            for (const path of Directory.Files(dir, "*.md"))
                this.Pages.Add(path, File.BaseName(path), `cat:${section.key}`,
                               "text-x-generic-symbolic");
        }
        this.Pages.ExpandAll();
    }

    /*
     * Show a page, and land on a member when there is one.
     *
     * `Find` is what lands, because the finest anchor a page has is its class and
     * what F1 on a property means is *the row that describes it*.
     *
     * **The first mention is the row**, and that is not luck: every page opens
     * with `## Every member` before any prose, so the first place a member's name
     * appears is its own line in that table. Searching for it in backticks would
     * find nothing — a code span's backticks are markup by the time the document
     * is laid out, and what the text really says is the word.
     */
    go(path, member) {
        if (!path || !File.Exists(path)) return false;

        if (this.Doc.Path && this.Doc.Path !== path) this.history.push(this.Doc.Path);
        this.BtnBack.Enabled = this.history.length > 0;

        this.Doc.Load(path);
        this.LblWhere.Text = File.Name(path);
        this.Text = Locale.Text("Reference -- {0}", File.BaseName(path));

        if (this.Pages.Exists(path)) {
            this.muted = true;
            this.Pages.Key = path;
            this.muted = false;
        }
        if (member) this.Doc.Find(member);
        return true;
    }

    Pages_Select() {
        if (this.muted) return;
        const key = this.Pages.Key;
        if (key && !key.startsWith("cat:")) this.go(key);
    }

    BtnBack_Click() {
        const back = this.history.pop();
        this.BtnBack.Enabled = this.history.length > 0;

        if (back) {
            /* Not through `go`, which would push the page being left and make
             * Back a way of going round in circles between two pages. */
            this.Doc.Load(back);
            this.LblWhere.Text = File.Name(back);
            if (this.Pages.Exists(back)) {
                this.muted = true;
                this.Pages.Key = back;
                this.muted = false;
            }
        }
    }

    /*
     * A link between two pages of the reference, which is what makes the *see
     * also* lists and the neighbour tables worth having. A `#anchor` never
     * arrives here -- the component scrolls to it on its own -- and anything
     * outside the reference is somebody else's.
     */
    Doc_Link(href, text) {
        const target = File.Absolute(File.Join(File.Directory(this.Doc.Path),
                                               href.replace(/#.*$/, "")));
        if (File.Exists(target) && File.Extension(target).toLowerCase() === "md")
            return this.go(target);

        this.LblWhere.Text = `${text} -> ${href}`;
        return true;
    }

    TxtFind_Activate() { this.find(); }
    TxtFind_IconClick() { this.TxtFind.Text = ""; }

    find() {
        const what = this.TxtFind.Text.trim();
        if (what) this.Doc.Find(what);
    }

    /* F3 is the next match, which is what every find box in this tree does. */
    Form_KeyPress(key) {
        if (key === "F3") { this.Doc.FindNext(); return true; }
        return false;
    }
}
