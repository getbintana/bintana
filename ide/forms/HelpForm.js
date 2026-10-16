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
        /* the IDE running from the source tree: <repo>/ide -> <repo>/docs.
         * Empty once the reference lives in `bintana-docs`, and kept for the
         * checkouts and installs that still carry it there. */
        File.Join(File.Directory(ide), "docs", "reference"),
        /* one hop from the binary, which is the same tree from anywhere else in
         * it: <repo>/build/bintana -> <repo>/docs. It is what makes the help
         * findable from a project that is not the IDE, and from the suite */
        File.Join(File.Directory(bin), "docs", "reference"),
        /* installed, and **the package the pages come from first**: the old
         * `share/doc/bintana/docs/reference` is kept for installs and checkouts
         * that still carry it, but a machine with both must not read a stale
         * copy of a page that moved. */
        File.Join(File.Directory(File.Directory(ide)), "doc", "bintana-docs", "docs", "reference"),
        File.Join(File.Directory(bin), "share", "doc", "bintana-docs", "docs", "reference"),
        File.Join(File.Directory(File.Directory(ide)), "doc", "bintana", "docs", "reference"),
        File.Join(File.Directory(bin), "share", "doc", "bintana", "docs", "reference"),
        "/usr/share/doc/bintana-docs/docs/reference",
        "/usr/share/doc/bintana/docs/reference",
    ];
}

/* The three folders, in the order the tree shows them.  The heading is not
 * here: `Locale.Text(SOME_CONST)` extracts nothing, so the literal lives at
 * the call site, in `sectionTitle`. */
const SECTIONS = [
    { key: "widgets"   },
    { key: "globals"   },
    { key: "libraries" },
];

/* Where the long form of every page is, for the reader of a build with no pages
 * beside it. */
const REFERENCE_ONLINE = "https://github.com/getbintana/bintana-docs/tree/main/docs/reference";

export class HelpForm extends Form {

    /*
     * What describes a name when there is no package: the IDE's `Completion`,
     * which asks the runtime.  Set by whoever opens the window, so this form
     * does not reach into the IDE for it.  Without a package and without this the
     * window has nothing to show, which is the one case left that says so.
     */
    static source = null;

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

    /*
     * A topic built from the runtime, for an installation with no reference
     * package: **the help has to work with only the runtime installed**, and
     * the members and descriptions are all in it (`Widget.Members`,
     * `Widget.EventDoc`). The text is Markdown because this window is already
     * a Markdown viewer; the last line points at the package's page for the
     * long form, and `Doc_Link` shows the address.
     *
     * `topic` is `{ Name, Member, Text, Where }`, which is what
     * `Completion.reference` answers.
     */
    static openTopic(topic) {
        if (!topic) return null;
        if (!HelpForm.window) HelpForm.window = new HelpForm();

        const help = HelpForm.window;
        help.Show();
        help.generated(topic);
        return help;
    }

    /*
     * The window on its index, for a reference that is not installed: a tree of
     * every control and global the runtime can describe, and a page that says
     * where the long form is.  With the package beside this build it is the
     * package's own README, as it always was.
     */
    static openIndex() {
        if (!HelpForm.window) HelpForm.window = new HelpForm();

        const help = HelpForm.window;
        help.Show();
        if (!help.root && HelpForm.source) help.index();
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
        this.current = "";
        this.root    = HelpForm.root();

        if (!this.root) {
            /* No pages: the runtime describes itself, which is the whole of what
             * a build with nothing but the runtime has. */
            if (HelpForm.source) {
                this.fillBuilt();
                this.index();
            } else {
                this.LblWhere.Text = Locale.Text("The reference is not installed beside this build.");
            }
            return;
        }
        this.fill();
        this.go(File.Join(this.root, "README.md"));
    }

    /* The tree of a reference built from the runtime: the same two sections, a
     * node per name, keyed `topic:Name` where a page's key is its path. */
    fillBuilt() {
        this.Pages.Clear();

        const names = HelpForm.source.referenceNames();
        for (const key of ["widgets", "globals"]) {
            this.Pages.Add(`cat:${key}`, this.sectionTitle(key), "", "folder-documents-symbolic");
            for (const name of names[key])
                this.Pages.Add(`topic:${name}`, name, `cat:${key}`, "text-x-generic-symbolic");
        }
        this.Pages.ExpandAll();
    }

    /* What a built reference opens on: where it comes from and where the rest
     * is.  Prose a person reads, so it goes through the catalogue. */
    index() {
        const text = [
            "# " + Locale.Text("Reference"),
            "",
            Locale.Text("The reference pages are not installed beside this build, so what the tree shows is built from the runtime itself: every member, and the sentence that describes it."),
            "",
            Locale.Text("The long form, with examples, is online:"),
            "",
            `[bintana-docs](${REFERENCE_ONLINE})`,
        ].join("\n");

        this.generated({ Name: Locale.Text("Reference"), Text: text, Where: REFERENCE_ONLINE }, "index:");
    }

    /* A built topic by name, in this window.  `false` when the runtime has
     * nothing to say about it. */
    showTopic(name, member) {
        const topic = HelpForm.source ? HelpForm.source.reference(name, member) : null;
        if (!topic) return false;

        this.generated(topic);
        return true;
    }

    /* The heading of a section, with the literal at the call site: a msgid held
     * in a `const` is one no extractor sees, and it was in no catalogue. */
    sectionTitle(key) {
        if (key === "widgets")   return Locale.Text("Controls");
        if (key === "globals")   return Locale.Text("Globals");
        if (key === "libraries") return Locale.Text("Libraries");
        return key;
    }

    /* The tree: a node per section, a node per page. The key is the path, so
     * choosing one needs no lookup at all. */
    fill() {
        this.Pages.Clear();
        this.byKey = {};

        for (const section of SECTIONS) {
            const dir = File.Join(this.root, section.key);
            if (!File.IsDir(dir)) continue;

            this.Pages.Add(`cat:${section.key}`, this.sectionTitle(section.key), "",
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

        if (this.current && this.current !== path) this.history.push(this.current);
        this.current = path;
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

    /*
     * The generated topic, in the same window as a page.
     *
     * The path is cleared, because `Doc_Link` resolves a link against the page
     * it is on and a generated one has none; the tree is left alone, so a
     * reader can go back to the last page by choosing it (and Back, when there
     * was one, still returns there).
     */
    generated(topic, key, quiet) {
        key = key || `topic:${topic.Name}`;

        /* `current` is a page's path or a built topic's key, so Back goes between
         * the two kinds: it used to know only paths, and a topic left no trace. */
        if (!quiet && this.current && this.current !== key) this.history.push(this.current);
        this.current = key;
        this.BtnBack.Enabled = this.history.length > 0;

        this.Doc.Path = "";
        this.Doc.Text = topic.Text;
        this.LblWhere.Text = topic.Where || "";
        this.Text = Locale.Text("Reference -- {0}", topic.Name);
        if (topic.Member) this.Doc.Find(topic.Member);
    }

    Pages_Select() {
        if (this.muted) return;
        const key = this.Pages.Key;
        if (key && key.startsWith("topic:")) this.showTopic(key.slice("topic:".length));
        else if (key && !key.startsWith("cat:")) this.go(key);
    }

    BtnBack_Click() {
        const back = this.history.pop();
        this.BtnBack.Enabled = this.history.length > 0;

        if (back === "index:") {
            this.index();
            this.history.pop();                 /* `index` pushed what it left */
            this.BtnBack.Enabled = this.history.length > 0;
        } else if (back && back.startsWith("topic:")) {
            const name  = back.slice("topic:".length);
            const topic = HelpForm.source ? HelpForm.source.reference(name) : null;
            if (topic) this.generated(topic, back, true);
        } else if (back) {
            /* Not through `go`, which would push the page being left and make
             * Back a way of going round in circles between two pages. */
            this.current = back;
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
        /* A built page's link to another built page. */
        if (href.startsWith("topic:"))
            return this.showTopic(href.slice("topic:".length));

        /* The web, for the long form: handed to whatever the desktop opens links
         * with, and where that cannot be had the address is shown, as it was. */
        if ((href.startsWith("https://") || href.startsWith("http://")) &&
            Application.HasCommand("xdg-open")) {
            Exec(["xdg-open", href], () => {}, () => {});
            return true;
        }

        const target = File.Absolute(File.Join(File.Directory(this.Doc.Path),
                                               href.replace(/#.*$/, "")));
        if (File.Exists(target) && File.IsExtension(target, "md"))
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
