/*
 * A directory listed into a `RowList`, and filtered without rebuilding a row.
 *
 * A row here is three controls -- an icon, a name and a size -- which is what a
 * `RowList` is for and what no `ListBox` of strings can hold. And the search box
 * over it is a `Filter`: the rows are built **once**, when the folder is read,
 * and GTK asks which of them to show.
 *
 *   Directory.List(folder)        the names, sorted, dotfiles included
 *   File.Info(path)         { Size, Modified, Type, Icon, IsDir } in one query
 *   List.Refilter()         "the answer may have changed, ask again"
 *   List_Filter(row, i)     ...and the answer itself, one row at a time
 *
 * **The counter at the bottom is the argument for it.** Type five letters into
 * the field: the rows built stays where it was, and the questions asked goes up
 * by five times the number of files. The other way of doing this is to empty the
 * list and build it again per keystroke -- which is what the IDE's property grid
 * did before `Filter` existed, and it takes the focus and the caret from whoever
 * is typing along with it.
 *
 * Run it with `./build/bintana examples/files`; it opens on the project's own folder.
 *
 * One note about the form, which JSON has no room for: `BtnUp` and `BtnFolder`
 * are in a `Panel` wearing `Style = "linked"`, so the two read as one control.
 * That is Adwaita's own class and nothing else is needed for it -- a `Panel` is
 * one widget, so a class on it lands on the box its children are in, which is
 * where every theme rule written against a direct child looks.
 */
"use strict";

/*
 * Which entry of `CmbKind` is which.
 *
 * **By index and not by text.** A `ComboBox`'s `Items` are prose -- the class
 * declares them as such, so the `.form` loader looks each one up in the
 * catalogue -- and `CmbKind.Text === "Folders"` is a comparison that holds
 * exactly until somebody runs this in Spanish. The index is what the *file*
 * says and no translation can move it.
 */
const KIND_ANY     = 0;
const KIND_FOLDERS = 1;
const KIND_TEXT    = 2;
const KIND_IMAGES  = 3;
const KIND_OTHER   = 4;

/*
 * What kind of thing a file is, from what `Info` already answered.
 *
 * `Type` is the content type -- `"image/png"`, `"text/javascript"` -- which is a
 * *value* one can test against, and the reason this needs no table of extensions
 * to keep up to date. GIO's human-readable description is the other thing, and it
 * arrives already translated into the desktop's language, so it is exactly what a
 * test like this must not be written against.
 */
function kindOf(info) {
    if (info.IsDir) return KIND_FOLDERS;

    const type = info.Type || "";

    if (type.startsWith("image/")) return KIND_IMAGES;
    if (type.startsWith("text/")  ||
        type === "application/json" ||
        type === "application/javascript" ||
        type === "application/x-shellscript") return KIND_TEXT;

    return KIND_OTHER;
}

/* kB and not KiB, because this list sits next to the desktop's own file manager
 * and that is the number it shows. */
function bytes(n) {
    if (!(n > 0)) return "0 B";

    const units = ["B", "kB", "MB", "GB", "TB"];
    let   size  = n;
    let   at    = 0;

    while (size >= 1000 && at < units.length - 1) {
        size /= 1000;
        at++;
    }
    return at === 0 ? `${size} B` : `${size.toFixed(1)} ${units[at]}`;
}

class Files extends Form {

    /*
     * One entry per row, **in row order**, and that is the whole of the
     * bookkeeping: what GTK hands the filter is a row index, and a row of
     * controls says nothing about which file it draws. A name would not do the
     * job either -- `Widget.Name` is an identifier, and `es.po` is not one.
     */
    files = [];

    /* Where we are. Empty until a folder has been read, which is what tells the
     * filter handlers that there is nothing to filter yet -- see `refilter`. */
    folder = "";

    /* The two numbers the status line is really about. */
    built = 0;
    asks  = 0;

    /* What the filter answers from, read off the controls once per change rather
     * than once per row: the handler runs inside GTK's layout and has no business
     * asking three widgets anything, forty times over. */
    needle = "";
    kind   = KIND_ANY;
    hidden = false;

    Form_Open() {
        /* A folder on the command line, and the project's own otherwise:
         * `./build/bintana examples/files ~/Documents`. */
        this.open(Application.Arguments[0] || Application.Directory);
        this.TxtFind.SetFocus();
    }

    /* --- reading a folder ---------------------------------------------------
     *
     * The one place that builds rows. Everything else on this form changes what
     * is *shown*, and none of it comes back here -- which is the point of the
     * example.
     */
    open(folder) {
        if (!File.IsDir(folder)) {
            Message.Error("{0} is not a folder.", folder);
            return;
        }

        let names;
        try {
            names = Directory.List(folder);
        } catch (e) {
            /* A folder that is there and cannot be read -- `/root` -- is an
             * answer and not a crash: say so, and stay where we were. */
            Message.Error("{0}", e.message);
            return;
        }

        this.folder = folder;
        this.LblPath.Text = folder;
        this.BtnUp.Enabled = File.Directory(folder) !== folder;

        this.List.Clear();
        this.files = [];
        this.built = 0;
        this.asks  = 0;

        /* Before the first row goes in: GTK filters a row as it arrives, so the
         * handler is already being asked while this loop runs. */
        this.readFilters();

        for (const name of names) {
            const path = File.Join(folder, name);

            /* `Info` answers `null` for a file that is not there any more --
             * a listing is a moment ago -- and an empty record is a row that
             * says nothing rather than one that throws. */
            const info = File.Info(path) || {};

            this.files.push({ name, path, info, kind: kindOf(info) });
            this.addRow(name, info);
        }

        this.List.Index = -1;
        this.BtnOpen.Enabled = false;
        this.showCount();
    }

    /*
     * One row: the icon the desktop draws for that kind of file, the name, and
     * the size on the right.
     *
     * `Info.Icon` is resolved by the runtime to a name this theme really has, so
     * there is nothing to guess and nothing to check -- and a folder shows no
     * size, because the number `Info` has for one is the size of the directory
     * entry and not of what is in it. A blank is honest; 4.1 kB is not.
     */
    addRow(name, info) {
        const row = new Panel();
        row.Arrangement = "Horizontal";
        row.Spacing = 8;
        row.Margin  = 4;

        this.List.Add(row);       /* the row first, then what goes inside it */
        this.built++;

        const icon = new Image();
        icon.Icon = info.Icon || "";
        icon.Size = 16;
        row.Add(icon);

        const label = new Label();
        label.Text      = name;
        label.HExpand   = true;
        label.Ellipsize = true;   /* a long name gives up its tail, not the row */
        row.Add(label);

        const size = new Label();
        size.Text  = info.IsDir ? "" : bytes(info.Size);
        size.Style = "dim-label";
        row.Add(size);
    }

    /* --- filtering ---------------------------------------------------------
     *
     * Asked by GTK, once per row, when a row arrives and when `Refilter` says
     * the answer may have changed.
     *
     * **A lookup and nothing that is not a lookup.** It runs while the list is
     * being laid out, so anything with a side effect here changes the world while
     * the world is being measured -- counting is as far as it goes, and even the
     * label that shows the count is written from `showCount` afterwards.
     */
    List_Filter(row, index) {
        this.asks++;
        return this.shows(this.files[index]);
    }

    /*
     * The predicate itself, on the file rather than on the row.
     *
     * One place decides, and both callers use it: the handler above for what GTK
     * draws, and `showCount` for what the status line claims. Two copies of this
     * rule is how a list comes to say *12 of 48* while showing thirteen.
     */
    shows(file) {
        if (!file) return true;      /* a row we know nothing about is shown */

        if (!this.hidden && file.name.startsWith(".")) return false;
        if (this.kind !== KIND_ANY && file.kind !== this.kind) return false;

        /* `Locale.Matches` and not `includes` on a lowercased name: `toLowerCase`
         * leaves an accent where it is, so `cordoba` never found `Córdoba`. It
         * matches anywhere in the name, folded. See `examples/contacts`. */
        return Locale.Matches(file.name, this.needle);
    }

    readFilters() {
        this.needle = this.TxtFind.Text.trim();
        this.hidden = this.ChkHidden.Active;

        /* Nothing chosen is a real state of a drop-down -- `Index` is `-1` for it
         * -- and here it means the same as the first entry: everything. */
        const at = this.CmbKind.Index;
        this.kind = at < 0 ? KIND_ANY : at;
    }

    /*
     * Everything that changes what is shown ends here, and nothing here builds
     * anything: read the three controls, tell the list the answer moved, count.
     *
     * **The guard is not defensive programming, it is the loader.** A `.form`
     * applies each property by assignment, and a control is put on the form
     * under its name only *after* its own properties are set -- so `Items` on
     * `CmbKind` raises `Select` while `this.CmbKind` is still undefined, and this
     * handler would run before there is a form to run on. `folder` is set by
     * `open` and by nothing else, which makes it the honest question: has a
     * folder been read yet?
     */
    refilter() {
        if (!this.folder) return;

        this.readFilters();
        this.List.Refilter();
        this.showCount();
    }

    TxtFind_Change()  { this.refilter(); }
    CmbKind_Select()  { this.refilter(); }
    ChkHidden_Click() { this.refilter(); }

    /* The button inside the field. It is `edit-clear-symbolic`, so it clears --
     * an icon in a text field is a promise about what pressing it does. */
    TxtFind_IconClick() {
        this.TxtFind.Text = "";
        this.refilter();
    }

    showCount() {
        const shown = this.files.filter((file) => this.shows(file)).length;

        this.LblCount.Text = Locale.Text(
            "{0} of {1} shown. {2} rows built, {3} filter questions since this " +
            "folder was opened — the rows survive the search, so a selection does too.",
            shown, this.files.length, this.built, this.asks);
    }

    /* --- the selection -----------------------------------------------------
     *
     * **`Index` counts every row, filtered or not**, which is exactly why
     * `this.files[index]` is the right lookup: the list holds all its rows, and
     * what a filter changes is what is on screen. An index that renumbered
     * itself as one typed would put these two arrays out of step at the first
     * keystroke.
     */
    get selected() {
        const at = this.List.Index;
        return at < 0 ? null : this.files[at];
    }

    List_Select() {
        const file = this.selected;

        this.BtnOpen.Enabled = file !== null;
        if (file) this.LblPath.Text = file.path;
    }

    BtnOpen_Click() {
        const file = this.selected;
        if (!file) return;

        /* A folder is entered; anything else is the desktop's business -- it is
         * the program that remembers what opens a .png. */
        if (file.info.IsDir) this.open(file.path);
        else                 File.Open(file.path);
    }

    BtnUp_Click() {
        this.open(File.Directory(this.folder));
    }

    BtnFolder_Click() {
        Dialog.SelectFolder(Locale.Text("Choose a folder to list"),
                            { Folder: this.folder },
                            (path) => this.open(path));
    }

    Panel1_MouseDown() {
        
    }
}
