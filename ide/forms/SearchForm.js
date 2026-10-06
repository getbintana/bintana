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
    BtnReplace_Click()    { this.replaceOne(); }
    BtnReplaceAll_Click() { this.replaceAll(); }

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

    /* The pattern the bar describes, or `null` when it is half typed -- the same
     * non-event it is for the search: `(` is a pattern nobody has finished. One
     * function, because the search and both replaces must not disagree about
     * what is being looked for. */
    patternNow() {
        const term = this.TxtTerm.Text;
        if (!this.ide.project || !term) return null;

        try {
            return this.patternOf(term, this.options());
        } catch (e) {
            this.LblCount.Text = Locale.Text("bad regex");
            return null;
        }
    }

    /* Runs it and fills the list. Answers how many there were, which is what
     * lets a caller say something when there were none. */
    search() {
        const term = this.TxtTerm.Text;

        this.clear();
        const re = this.patternNow();
        if (!re) return 0;

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

    /* --- replacing ----------------------------------------------------------
     *
     * The same pattern the search built, run over a file's own text. Two rules
     * keep it honest, and both are about not writing where nobody asked:
     *
     *   a `.form` is a drawing and a catalogue has its own editor, so neither is
     *   a file this window edits -- `opensInTab` is the table that already says
     *   which files those are;
     *
     *   and a file that is not UTF-8 is refused by `TabSet.rewriteSource` with
     *   the sentence the IDE says everywhere else.
     */
    replacementSpec() {
        const text = this.TxtReplace.Text;

        /* With the search literal the replacement is too, and a **function** is
         * what keeps a `$` a `$`: a string spec goes through `Regex`'s own
         * expansion, where `$1` is a group and `$$` is one dollar -- and
         * `"$3,50"` is neither. */
        if (this.ChkRegex.Active) return text;
        return () => text;
    }

    /* The chosen files that hold the pattern and can be written. */
    replaceableFiles(re) {
        const out = [];

        for (const name of this.chosenFiles()) {
            if (File.IsExtension(name, "form")) continue;
            if (!opensInTab(name)) continue;

            const path = File.Join(this.ide.project, name);
            if (!File.Exists(path) || Ide.TabSet.notUtf8(path)) continue;

            let text;
            try {
                text = File.Load(path);
            } catch (e) {
                continue;
            }
            const count = re.Matches(text).length;
            if (count > 0) out.push({ name, count });
        }
        return out;
    }

    /*
     * One occurrence replaced, the one the selected row stands on.
     *
     * The place is re-found in the text the writer is handed rather than trusted
     * by offset: a file may have changed since the search, and a replacement
     * that landed one line off is a wrong edit with no undo. A place that no
     * longer holds the match is left alone.
     */
    hitReplacement(hit, re, spec, text) {
        const lines = text.split("\n");
        const line  = lines[hit.line - 1];
        if (line === undefined) return text;

        let at = hit.column - 1;
        for (let i = 0; i < hit.line - 1; i++) at += lines[i].length + 1;

        const tail = text.slice(at);
        const m    = re.Match(tail, 0);
        if (!m || m.Index !== 0 || m.Length !== hit.length) return text;

        return text.slice(0, at) + re.Replace(tail, spec, 1);
    }

    replaceOne() {
        const hit = this.hits.get(this.Results.Key);
        if (!hit) {
            this.ide.log(`${Locale.Text("Choose one of the matches to replace it.")}\n`);
            return false;
        }

        const re = this.patternNow();
        if (!re) return false;

        const spec = this.replacementSpec();
        let   done = false;

        this.ide.tabs.rewriteSource(hit.file, (text) => {
            const next = this.hitReplacement(hit, re, spec, text);

            if (next !== text) done = true;
            return next;
        });

        if (done) {
            /* The newline is the log's and not the translator's. */
            this.ide.log(`${Locale.Text("{0}:{1}: replaced", hit.file, hit.line)}\n`);
            this.search();
        }
        return done;
    }

    /*
     * Every occurrence, in every chosen file that holds one -- asked first,
     * because it is the one edit here without an undo: a file that is not open
     * has no editor history to take it back with.
     */
    replaceAll() {
        const re = this.patternNow();
        if (!re) return false;

        const spec    = this.replacementSpec();
        const targets = this.replaceableFiles(re);

        if (targets.length === 0) {
            this.ide.log(`${Locale.Text("Nothing to replace.")}\n`);
            return false;
        }

        let total = 0;
        for (const target of targets) total += target.count;

        /* Kept where a test can reach it, as every modal here is: a window with
         * no other reference is a question nobody can answer in a suite. */
        this.confirmReplace = ConfirmForm.ask(
            Locale.Text("Replace in project"),
            Locale.Plural("Replace {0} occurrence in {1} file?",
                          "Replace {0} occurrences in {1} files?",
                          total, targets.length),
            Locale.Text("Replace"),
            () => {
                for (const target of targets)
                    this.ide.tabs.rewriteSource(target.name,
                                                (text) => re.Replace(text, spec));

                this.ide.log(`${Locale.Plural("{0} replacement made",
                                              "{0} replacements made",
                                              total)}\n`);
                this.search();
            });
        return true;
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
