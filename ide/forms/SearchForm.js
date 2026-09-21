/*
 * Find in project: the same term against every file the project owns, in a
 * window of its own.
 *
 * A window and not a bar, which is the opposite of what `Finder` is and for the
 * opposite reason. A find bar has to be a bar because the text it searches must
 * stay visible while one types in it; this one searches files that are *not* on
 * screen, so there is nothing to keep visible -- and what it has instead is a
 * result set, which is a list, a count and somewhere to go from each row. That
 * does not fit in a strip under the editor.
 *
 * **Not modal**, like `PoForm` and for the same reason: the point of a result is
 * to be gone to, and going to it means working in the window behind this one.
 * One at a time, raised rather than opened twice, so the last search is still
 * there when it comes back.
 *
 * **The searching is JavaScript's and not the runtime's**, and that is the honest
 * split rather than a shortcut: `SourceEditor.Search` is a widget's search over the
 * buffer a person is looking at -- it highlights, it walks matches, it belongs to
 * the view. A file that is not open has no widget, and loading a hundred of them
 * into editors nobody asked for, to reuse that code, would cost far more than a
 * `RegExp` over the text. What the runtime is asked for is what only it can
 * answer: `Directory.List` and `File.Load`.
 */
"use strict";

/* The one that is open, if any: `Ctrl+Shift+F` raises it rather than stacking a
 * second window with a second answer to the same question. */
let openSearch = null;

/*
 * How many hits are listed. Not a limit on the *search* -- the count is the real
 * one -- and said out loud in the label when it bites, because a list that
 * silently stops reads exactly like a project with nothing else in it.
 */
const SEARCH_LISTED = 500;

/* What kind of icon a file gets in the results, by the names the project tree
 * uses -- so a result looks like the file it is about. */
function searchIcon(name) {
    const ext = File.Extension(name).toLowerCase();
    if (ext === "js")   return "code";
    if (ext === "form") return "form";
    if (ext === "po" || ext === "pot") return "catalogue";
    return "file";
}

class SearchForm extends Form {

    /*
     * Opens it, or raises the one already up.
     *
     * `ide` is passed rather than reached for: this window is a form like any
     * other and has no more access to the IDE than it is handed.
     */
    static find(ide, term) {
        const dlg = openSearch || new SearchForm();

        if (!openSearch) {
            dlg.ide = ide;
            openSearch = dlg;
        }
        dlg.Show();

        /* The project's extensions as they are *now*: files come and go while
         * this window sits in the background, and the moment that matters is
         * the one it is being looked at again. What was chosen is kept if the
         * project still has it. */
        dlg.fillFilters();

        /* What one meant to look for: the selection, as `Ctrl+F` takes it -- a
         * selection spanning lines is a block someone highlighted and not a
         * search term. Whatever is already in the field survives an empty one,
         * which is what makes reopening it a way back to the last search. */
        if (term && !term.includes("\n")) dlg.TxtTerm.Text = term;

        dlg.TxtTerm.SetFocus();
        if (dlg.TxtTerm.Text) dlg.search();
        return dlg;
    }

    /* The one that is up, or null. What `find` raises, and the only handle on
     * it there is: nothing else may hold one, or closing it would leave a
     * window behind that nobody can see. */
    static get open() { return openSearch; }

    Form_Open() {
        this.hits = new Map();
    }

    Form_Close() {
        openSearch = null;
    }

    BtnClose_Click() { this.Close(); }
    BtnFind_Click()  { this.search(); }

    /* --- what to look in ---------------------------------------------------
     *
     * The list is the project's own extensions and not a table written here: a
     * project with no catalogues should not be offered `*.po`, and one holding
     * something this file never heard of should be. Discovered, like everything
     * else in this IDE that could have been a list.
     *
     * The labels are *values* and not prose -- `*.js` is not a word anybody
     * translates -- so only the first entry goes through the catalogue. Putting
     * keywords in a `ComboBox.Items` from a `.form` is what translates them, and
     * that is the trap this avoids by filling it from code.
     */
    fillFilters() {
        const was = this.filters
                    ? this.filters[Math.max(this.CboFiles.Index, 0)].ext : "";

        const exts = [...new Set(this.ide.files.map((f) => File.Extension(f).toLowerCase()))]
                     .filter((e) => e)
                     .sort();

        this.filters = [{ label: Locale.Text("Every file"), ext: "" },
                        ...exts.map((e) => ({ label: `*.${e}`, ext: e }))];

        this.CboFiles.Items = this.filters.map((f) => f.label);

        const at = this.filters.findIndex((f) => f.ext === was);
        this.CboFiles.Index = at < 0 ? 0 : at;
    }

    /* The three switches and the file filter, as one answer. */
    options() {
        return {
            CaseSensitive: this.ChkCase.Active,
            WholeWord:     this.ChkWord.Active,
            Regex:         this.ChkRegex.Active,
        };
    }

    /* Which files this run looks at. An extension and not a glob, which is the
     * same bargain `Dialog.OpenFile`'s filters make: `*.js` is a suffix there
     * too, and two spellings of "which files" in one program is one too many. */
    chosenFiles() {
        const pick = this.filters[Math.max(this.CboFiles.Index, 0)];
        if (!pick || !pick.ext) return this.ide.files;

        return this.ide.files.filter((f) => File.IsExtension(f, pick.ext));
    }

    /* --- the search itself -------------------------------------------------
     *
     * Escaped unless `Regex` is on -- a search for `a.b` must not match `axb` --
     * and `\b` around it for whole words, which is the rule `SourceEditor.Search`
     * carries out in C for the editor.
     */
    patternOf(term, options) {
        let source = options.Regex ? term : Regex.Escape(term);
        if (options.WholeWord) source = `\\b(?:${source})\\b`;

        return new Regex(source, { IgnoreCase: !options.CaseSensitive });
    }

    /*
     * Every hit in one file's text.
     *
     * `Matches` is asked once per line and hands back the lot, which is also
     * where the empty-match trap went: `\b`, `x*` and a half-typed group all
     * match nothing at all, and a `lastIndex` that did not move was an infinite
     * loop with the window frozen.  Regex steps over it; nothing here has to
     * know that it could happen.
     */
    hitsIn(name, text, re) {
        const out = [];

        text.split("\n").forEach((line, i) => {
            for (const match of re.Matches(line)) {
                out.push({ file: name, line: i + 1, column: match.Index + 1,
                           length: match.Length, text: line.trim() });
            }
        });
        return out;
    }

    /* Runs it and fills the list. Answers how many there were, which is what
     * lets a caller say something when there were none. */
    search() {
        const term = this.TxtTerm.Text;

        this.clear();
        if (!this.ide.project || !term) return 0;

        let re;
        try {
            re = this.patternOf(term, this.options());
        } catch (e) {
            /* A regex half typed is the same non-event it is in the find bar:
             * `(` is a pattern nobody has finished. */
            this.LblCount.Text = Locale.Text("bad regex");
            return 0;
        }

        const found = [];
        for (const name of this.chosenFiles()) {
            let text;
            try {
                text = File.Load(File.Join(this.ide.project, name));
            } catch (e) {
                /* A file the tree lists and the disk no longer has is not this
                 * window's business to report: the next refresh drops it. */
                continue;
            }
            found.push(...this.hitsIn(name, text, re));
        }

        this.fill(term, found);
        return found.length;
    }

    /* The results as a tree: a node per file, a node per hit under it. */
    fill(term, found) {
        const files = [];
        for (const hit of found) {
            if (!files.length || files[files.length - 1].name !== hit.file)
                files.push({ name: hit.file, hits: [] });
            files[files.length - 1].hits.push(hit);
        }

        let listed = 0;
        for (const file of files) {
            if (listed >= SEARCH_LISTED) break;

            const key = `f:${file.name}`;
            this.Results.Add(key, `${file.name}  (${file.hits.length})`, undefined,
                             this.ide.treeIcon(searchIcon(file.name)));

            for (const hit of file.hits) {
                if (listed >= SEARCH_LISTED) break;

                /* An opaque key and a table beside it, rather than packing the
                 * file, the line and the column into the string and picking them
                 * back out: a key is an address here, not a record. */
                const at = `h:${listed++}`;
                this.hits.set(at, hit);
                this.Results.Add(at, `${hit.line}: ${hit.text}`, key);
            }
        }

        this.LblCount.Text = found.length === 0
            ? Locale.Text('No file contains "{0}"', term)
            : listed < found.length
                ? Locale.Text('{0} of {1} matches for "{2}", in {3} files',
                              listed, found.length, term, files.length)
                : Locale.Plural('One match for "{1}", in {2} files',
                                '{0} matches for "{1}", in {2} files',
                                found.length, term, files.length);
    }

    clear() {
        this.hits.clear();
        this.Results.Clear();
        this.LblCount.Text = "";
    }

    /*
     * Going to one.
     *
     * On `Activate` -- double click or Enter -- and never on selection, for the
     * reason a catalogue is opened that way: a selection moves with the arrow
     * keys, and a list that opened a tab per row walked through would be
     * unusable.
     *
     * A file node opens the file and nothing else: there is no one line it
     * stands for. A hit takes the editor to the match itself, which is what
     * `Editor.Select` is for; a `.form` opens in the designer, which has no
     * text to point at, and that is the same answer the IDE gives everywhere
     * else about a form being a drawing rather than a file one reads.
     */
    Results_Activate() {
        const key = this.Results.Key;
        const hit = this.hits.get(key);
        const name = hit ? hit.file : (key.startsWith("f:") ? key.slice(2) : "");
        if (!name) return;

        if (Ide.Translations.isCatalogue(name)) {
            this.ide.openCatalogue(name);
            return;
        }
        this.ide.openInTab(name);

        if (hit && this.ide.Editor) {
            this.ide.Editor.Select(hit.line, hit.column, hit.length);
            this.ide.Editor.SetFocus();
        }
    }
}
