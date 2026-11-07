/*
 * The two checks that read a name against what the `.form` beside it says, with
 * no editor in sight.
 *
 * They were `Live`'s, and they still run from there on every pause -- but
 * the *file on screen* is one file, and three of the mistakes they catch are
 * just as wrong in a file nobody has open. `Check` walks the project with
 * the same two, which is why they are here and not there: a second copy of
 * *does this control have this member* is a second answer to drift from the
 * first, and this project has said so about `Git`'s commands, about
 * `SOURCE_LINK` and about `Navigator.symbols` already.
 *
 * What they need is a **table** -- `[{ name, type }, …]`, everything one form
 * names, flattened -- and the text of the class beside it. `tableOf` is that
 * walk and it is the only one: `Live` gets its table from `Completion`,
 * which keeps one per form for the completion popup, and `Check` builds one
 * per file as it walks, and both of them go through here.
 *
 * **The third check here asks about no `.form` at all**, and that is deliberate
 * rather than a widening: it reads the language's own answer to *is this a name
 * this language has*, which is `Application.Replacements()` -- a table the
 * runtime builds from the very rows `close_hatches` deletes, so what was taken
 * and what to write instead cannot disagree. It is a method of its own and not
 * part of `check()` for the same reason the other two are not `Check`'s: it
 * needs the caret rule below, and a second copy of "is this under the cursor" is
 * a second answer to drift from the first. Both callers add it themselves, which
 * is what stops a form's class being told about it twice.
 *
 * **They did not, and all three had the same hole.** Each walked a `.form`'s
 * `children`, and `menus` and `actions` are not among them -- they are blocks of
 * their own, and the loader binds what they name on the form exactly as it binds
 * a control. So `this.MnuSave.` proposed nothing, `MnuSave_Clik()` went
 * unremarked, and a menu item called `Actions` was a collision nothing looked
 * for. Three copies of *what does this form have*, all drifted to the same wrong
 * answer -- which is the argument for having one, made over again.
 *
 * Neither check parses JavaScript, and that is what makes this possible at all:
 * a `.form` says what every control *is*, which is the type declaration an
 * editor for this language would otherwise have to infer.
 *
 * **This is the library's copy, and it is the one the IDE and `bintana check`
 * both run.** The IDE loads it through `uses: ["check"]`; the command line loads
 * it through `tools/check`. There is no second copy to keep in step.
 */
"use strict";

/* `this.Name.Member`, and a method that looks like a handler -- `Name_Event(` at
 * the start of a line, which is how every handler in every project of this
 * language is written. Compiled once and shared: a `Regex` remembers nothing
 * between calls, so one pass cannot resume where another stopped. */
const NAMES_MEMBER  = new Regex("\\bthis\\.([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)");
const NAMES_HANDLER = new Regex(
    "^[ \\t]*([A-Za-z_$][\\w$]*)_([A-Za-z_$][\\w$]*)[ \\t]*\\(", { Multiline: true });

/*
 * A call: the target, dotted or not, and the parenthesis. The guard in front
 * refuses a `.`, so `x.setTimeout(` is somebody else's member and not a name of
 * this language's. Anchored on a character class rather than a lookbehind, which
 * is a thing this dialect of `Regex` has and this tree uses elsewhere.
 */
const NAMES_CALL = new Regex(
    "(?:^|[^A-Za-z0-9_$.])([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*)[ \\t]*\\(",
    { Multiline: true });

/*
 * A control built in code and named where it is built.
 *
 * A handler is `Name_Event` on the form, and a control made in a method joins
 * the form by name exactly as one declared in the `.form` does -- `Btn.Name =
 * "Save"` is the line that makes `Save_Click` reachable. The two shapes below
 * are the ones every project in this tree writes; the point of reading them
 * over the **whole project** is that the control and its handler need not live
 * in the same file: `Workspace.js` builds the IDE's `WidgetTree`, and
 * `MainForm.js` handles `WidgetTree_Select`.
 */
const BUILT_NAME = new Regex(
    "\\.Name[ \\t]*=[ \\t]*[\"']([A-Za-z_$][\\w$]*)[\"']", { Multiline: true });
const BUILT_THIS = new Regex(
    "\\bthis\\.([A-Za-z_$][\\w$]*)[ \\t]*=[^=]", { Multiline: true });

/* `typeof X`: the file asks whether a name exists. Over blanked text, so a
 * `typeof` in a comment excuses nothing. */
const TYPEOF_NAME = new Regex("\\btypeof[ \\t(]*([A-Za-z_$][\\w$]*)", { Multiline: true });

/* How many single-character edits turn one word into the other -- insertions,
 * deletions, substitutions and a swap of two neighbours, which is the typo a
 * hand makes most. Two rows at a time; the words are identifiers. */
function editDistance(a, b) {
    let prev2 = null;
    let prev  = Array.from({ length: b.length + 1 }, (_, j) => j);

    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        for (let j = 1; j <= b.length; j++) {
            let d = Math.min(prev[j] + 1, row[j - 1] + 1,
                             prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                d = Math.min(d, prev2[j - 2] + 1);
            row.push(d);
        }
        prev2 = prev;
        prev  = row;
    }
    return prev[b.length];
}

/* The one name close enough to be what was meant, or `""`. One edit for a
 * short word and two from five letters on -- a three-letter name is one edit
 * away from too many others to suggest any -- and a tie says nothing rather
 * than picking. Case is the cheapest mistake and is tried first. */
function nearest(name, candidates) {
    const lower = name.toLowerCase();
    if (name.length < 3) return "";
    let best = "", bestD = name.length >= 5 ? 3 : 2, tie = false;

    for (const c of candidates) {
        if (c === name || Math.abs(c.length - name.length) >= bestD) continue;
        const d = c.toLowerCase() === lower ? 0 : editDistance(name, c);
        if (d < bestD) { best = c; bestD = d; tie = false; }
        else if (d === bestD && c !== best) tie = true;
    }
    return best && !tie ? best : "";
}

/* The words that make a call-shaped token a declaration rather than a call. A
 * project may define its own `setTimeout`, and the runtime's table knows nothing
 * about that -- so these are asked of the word in front and then ignored. */
const DECLARING  = /^(function|class|const|let|var)$/;
const WORD_BEFORE = /[A-Za-z_$][\w$]*[ \t]*$/;

/* A file as the runtime's messages name it: relative to the project as the
 * tabs already are, and a library's as `<library>/<file>`. */
function shownPath(f) {
    if (!/^([A-Za-z]:)?[\\/]/.test(f)) return f;
    return File.Join(File.Name(File.Directory(f)), File.Name(f));
}

/* How many characters -- code points, as the editor counts them -- are between
 * two UTF-16 indices. A surrogate pair is one character on screen and two in
 * the string, and a diagnostic on a line with an emoji before it has to say
 * the column the cursor would. */
function charsBetween(text, from, to) {
    let n = 0;

    for (let i = from; i < to; ) {
        const c = text.charCodeAt(i);
        i += (c >= 0xD800 && c <= 0xDBFF && i + 1 < to) ? 2 : 1;
        n++;
    }
    return n;
}

/* Where a match is, in the editor's units: line 1-based, column and length in
 * characters. `Regex` reports UTF-16 indices, which is what `Text.LineOf`
 * takes; `column` is what `Select` and `Diagnostic` take. */
function placeAt(text, index, length) {
    const line  = Text.LineOf(text, index);
    const start = text.lastIndexOf("\n", index - 1) + 1;

    return {
        line,
        column: charsBetween(text, start, index) + 1,
        length: charsBetween(text, index, index + length),
    };
}

export class Names {

    /** @param {object} host what this process can answer beyond a widget class:
     * `componentEvents(type)` for a project component, and `owners()` for the
     * names two modules export. Both are optional; without them the checks that
     * need them say nothing rather than guess. */
    constructor(host = {}) {
        this.host = host;

        /* The runtime's widget classes. `MenuItem` and `Action` are not in this
         * set -- they are not widgets -- but their classes answer too now, so
         * `runtimeType` is the question the checks ask rather than this set. */
        this.widgets = new Set(Widget.Types());

        /*
         * The names this language took, read once: the runtime's own table, and
         * a set of its keys because the question is asked once per call-shaped
         * token in a file. `Check` builds the same table over the whole
         * project, and the alternative -- a list of taken names written here --
         * would be a second answer that goes stale the moment the runtime takes
         * one more, which is the mistake this whole module is arranged against.
         */
        this.replaced = Application.Replacements();
        this.retired  = new Set(Dictionary.Keys(this.replaced));

        /*
         * The names a control built in code gives itself, over the whole
         * project. `Check` hands them in before its pass, and because `Live`
         * shares this instance it reads the same answer -- a handler for a
         * control built in another module is not an orphan.
         */
        this.builtNames = null;
    }

    /*
     * The names a project's text gives a control it builds: `btn.Name = "Save"`
     * and `this.Btn = new Button()`. `Check` calls this once over every `.js`
     * it is about to read; a caller with one file can hand in that file alone,
     * which is the old same-file answer.
     */
    static builtIn(texts) {
        const out = new Set();

        for (const text of texts || []) {
            for (const m of BUILT_NAME.Matches(text)) out.add(m.Group(1));
            for (const m of BUILT_THIS.Matches(text)) out.add(m.Group(1));
        }
        return out;
    }

    /* What `orphan` consults before it calls a handler dead. `null` goes back to
     * the same-file reading, which is what a caller that never walks a project
     * gets. */
    setBuiltNames(names) {
        this.builtNames = names || null;
    }

    /* Every class the project's text declares, and what it extends: what
     * `shadowing` walks to find the runtime class under a class declared in
     * another file. `Check` hands in every `.js`; one file is its own answer. */
    static classTree(texts) {
        const out = new Map();
        for (const text of texts || []) {
            let syms;
            try { syms = Application.Symbols(text); } catch (e) { continue; }
            for (const sym of syms)
                if (sym.Kind === "Class" && sym.Name) out.set(sym.Name, sym.Super || "");
        }
        return out;
    }

    setClassTree(tree) {
        this.classTree = tree || null;
    }

    /*
     * **A member that hides a control's with another shape.** Every control
     * is one object with one table of names, and a component or a form of
     * the project extends one: declaring `Expand(key)` on it hides the
     * `Expand` every control has, the layout property -- and works, until a
     * `.form` says `Expand: true`, which puts a boolean on that control and
     * the method is gone. A property over a method is the verb the base
     * loses: `Remove(index)` on six controls hid the `Remove()` that takes a
     * control out of its container. The runtime's own classes are held to
     * this by `tests/api.sh`; this is the same rule for the project's.
     *
     * Said when the kinds differ (a method against a property) or a method
     * takes another number of parameters. The same shape is an override and
     * is left alone, and so is an arity the base leaves open (`[x]`,
     * `...rest`) -- the rule is no wider than what a parser can tell.
     */
    *shadowing(text, file, caret) {
        let syms;
        try { syms = Application.Symbols(text); } catch (e) { return; }

        const supers = new Map(this.classTree || []);
        for (const sym of syms)
            if (sym.Kind === "Class" && sym.Name) supers.set(sym.Name, sym.Super || "");

        const known = new Map();
        const membersOf = (name) => {
            if (!known.has(name)) {
                let list = null;
                try { list = Widget.Members(name); } catch (e) { list = null; }
                known.set(name, list);
            }
            return known.get(name);
        };
        /* Up the chain to the first class the runtime answers for. */
        const baseOf = (cls) => {
            let at = supers.get(cls);
            for (let hops = 0; at && hops < 32; hops++) {
                const list = membersOf(at);
                if (list) return { name: at, list };
                at = supers.get(at);
            }
            return null;
        };

        const said = new Set();
        for (const sym of syms) {
            if (!sym.Parent || !(sym.Kind === "Method" || sym.Kind === "Getter" || sym.Kind === "Setter"))
                continue;
            const first = sym.Name.charAt(0);
            if (!(first >= "A" && first <= "Z")) continue;
            if (said.has(`${sym.Parent}.${sym.Name}`)) continue;

            const base = baseOf(sym.Parent);
            const b    = base ? base.list.find((m) => m.Name === sym.Name) : null;
            if (!b) continue;

            const mine   = sym.Kind === "Method" ? "method" : "property";
            const theirs = b.Kind === "Method" ? "method" : "property";
            const sig    = b.Signature || "()";
            let   why    = "";

            if (mine === "method" && theirs === "property")
                why = `${sym.Parent}.${sym.Name}${sym.Params} hides ${base.name}'s ` +
                      `${sym.Name}, a property every control has: a .form or a ` +
                      `program assigning ${sym.Name} puts a value on that control ` +
                      `and the method is gone -- name it for what it does`;
            else if (mine === "property" && theirs === "method")
                why = `${sym.Parent}.${sym.Name} hides ${base.name}.${sym.Name}${sig}, ` +
                      `a method every control has: whatever calls it on this ` +
                      `control gets the property -- name it for what it is`;
            else if (mine === "method" && !sig.includes("[") && !sig.includes("...") &&
                     !(sym.Params || "").includes("...") &&
                     paramCount(sym.Params) !== paramCount(sig))
                why = `${sym.Parent}.${sym.Name}${sym.Params} hides ` +
                      `${base.name}.${sym.Name}${sig} with another signature: code ` +
                      `calling the control's own ${sym.Name} on this one gets ` +
                      `this one -- name it for what it does`;
            if (!why) continue;

            said.add(`${sym.Parent}.${sym.Name}`);
            yield { kind: "Warning", file, line: sym.Line, text: why };
        }
    }

    /* Whether the runtime can answer for this type with no window: every widget,
     * and the two classes a `.form`'s loader makes. */
    runtimeType(type) {
        return this.widgets.has(type) || type === MENU_ITEM_TYPE || type === ACTION_TYPE;
    }

    /*
     * Every problem the text has against that table.
     *
     * `caret` is an offset into the text, or `-1` for *nobody is typing in this*
     * -- which is what a project pass is. A match the caret is inside is never
     * reported: a diagnostic about the token the cursor is in is a diagnostic
     * about something still being typed.
     */
    check(text, controls, file, caret) {
        return [...this.members(text, controls, file, caret),
                ...this.handlers(text, controls, file, caret)];
    }

    /*
     * `setTimeout(fn, 100)` and `Object.assign(a, b)`: a name this language
     * has taken, said with the word to write instead.
     *
     * **It is asked of call targets and of nothing else, which is half of the
     * safety of it.** A bare-identifier scan would report a property
     * (`x.setTimeout`), a key (`{ setTimeout: 1 }`), a declaration
     * (`function setTimeout()`) and every mention inside a string or a comment --
     * and a check that says so is a check somebody switches off, which is what
     * `handlers()`'s paragraph is about. A call is the shape every one of these
     * takes when a person reaches for one:
     *
     *     NAMES_CALL  the guard refuses a `.` in front, so a method on somebody
     *             else's object is not ours to complain about -- and a dotted
     *             target is not in the table either, whose keys are a bare
     *             global or an `Object.` one, so `host.setTimeout(0)` cannot
     *             match a row whatever it is called
     *     DECLARING  the five words that make a call-shaped token a *declaration*
     *             instead: a project is allowed to define its own `setTimeout`,
     *             and the table knows nothing about that
     *
     * **And the other half is that the scan is run over `Lex.blank`ed
     * text.** The two guards above read the text, and text is where prose
     * lives: it reported `setTimeout(fn, 1)` out of a comment *and* out of a
     * string, out of the fixture written to prove it would not -- and the
     * assertion that said so was passing because the pass never looked at that
     * file, which is the `p_names` note there. Blanking costs one walk, keeps
     * every offset, and gives the two guards something they can be right about.
     *
     * An `""` replacement is reported too, and differently: there is no word for
     * that thing here, which is worth saying out loud rather than leaving as a
     * bare `ReferenceError` at the next run.
     */
    *curated(text, file, caret) {
        /* Blanked once and read twice: the match list and the word in front of
         * a name both come from the same text, and a `function` in a comment
         * must not be the one that saves a declaration. Offsets are the
         * original's, so `caret`, `m.Index` and `Text.LineOf` need no
         * translation -- that is the bargain `Lex.blank` makes. */
        const code = Lex.blank(text);

        for (const m of NAMES_CALL.Matches(code)) {
            if (underCaret(m, caret)) continue;

            const name = m.Group(1);
            if (!this.retired.has(name)) continue;

            /*
             * The word in front of the *name*, not of the match: the match starts
             * on its guard character, and at the start of a line that character
             * is the line break -- so asking the text before the match would read
             * `function` on the line above and miss the declaration, which is the
             * one shape that must not be reported. Both sides of that question
             * come from the blanked text: a `function` in a comment must not be
             * the one that saves a declaration.
             */
            if (DECLARING.test(wordBefore(code, m.Index + m.Value.indexOf(name))))
                continue;

            const use = this.replaced[name];
            const at  = placeAt(text, m.Index, m.Value.length);

            yield {
                kind: "Warning",
                file,
                line: at.line,
                column: at.column,
                length: at.length,
                text: use
                    ? `${name} is not part of this language: use ${use}`
                    : `${name} is not part of this language, and nothing here ` +
                      `replaces it`,
            };
        }
    }

    /*
     * A name two modules export, used here with no `import` to say whose.
     *
     * The runtime refuses to start such a program -- *Main.js:3: 'Parser' is
     * exported by Csv.js and Ini.js: choose one with import* -- so this is the
     * same sentence said while typing, where the word is (modules-plan,
     * stage 4). A file is named as the runtime names it: by its path in the
     * project, or `<library>/<file>`, never by its name alone, which made two
     * `Csv.js` in two folders one word. Who exports what is `Completion`'s per-file reading, kept
     * live over the open tabs; a file that imports the name, or declares one
     * of its own anywhere in it, is skipped whole rather than guessed at, and
     * a member (`x.Parser`) is not the shared name.
     */
    *ambiguous(text, file, caret) {
        const owners = this.host.owners ? this.host.owners() : null;
        if (!owners || !owners.size) return;

        let syms;
        try { syms = Application.Symbols(text); } catch (e) { return; }
        const mine = new Set(syms.filter((s) => s.Kind === "Import" || s.Kind === "Class" ||
                                                s.Kind === "Function" || s.Kind === "Variable")
                                 .map((s) => s.Name));
        const code = Lex.blank(text);

        for (const [name, files] of owners) {
            if (files.length < 2 || mine.has(name)) continue;

            const who  = files.map(shownPath);
            const list = who.length === 2 ? who.join(" and ")
                       : `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}`;
            const re   = new Regex(`(^|[^A-Za-z0-9_$.])${Regex.Escape(name)}(?![A-Za-z0-9_$])`,
                                   { Multiline: true });
            for (const m of re.Matches(code)) {
                if (underCaret(m, caret)) continue;

                const start = m.Index + m.Value.indexOf(name);
                const at    = placeAt(text, start, name.length);

                yield {
                    kind: "Warning",
                    file,
                    line: at.line,
                    column: at.column,
                    length: at.length,
                    text: `'${name}' is exported by ${list}: choose one with import`,
                };
            }
        }
    }

    /*
     * `helpr()`, `undefinedThing.foo`, `totl = 3`: a name nothing in the
     * program declares, which is a `ReferenceError` on the day that line runs.
     *
     * **The compiler says which names are free, and nothing here guesses
     * it.** `Application.FreeNames` is the bytecode's own answer -- a local, a
     * parameter, a class field, an import and the file's own module top level
     * are bound and never listed -- and it has already taken away what the
     * runtime answers (its globals, the builtins, the prelude's `hasOwn`). What
     * is left has to be answered by the rest of the program, which is
     * `host.answers()`: what every file of the project and of its libraries
     * publishes, out of `Owners.answers` (or the completion's own cache in the
     * IDE). **Nothing else is a source of names**, so a name a program makes
     * some other way -- an assignment through a namespace object, a native
     * plugin -- is the price; `Namespace("A")` is read because it is the one
     * way this language has to publish one.
     *
     * Three things are left alone, each for a reason a person would give:
     *
     *     a name the language took    `curated` says it, with what to write
     *     `typeof X` anywhere in it   the file asks whether X exists; a use
     *                                 behind that guard is the point of it
     *     the word under the caret    still being typed
     *
     * A name another module declares and keeps is said as that, because it is
     * the one mistake whose fix is in another file: the runtime refuses the
     * same use at load, with the same file named. Anything else gets the
     * nearest name the file could have meant, when there is one close enough.
     *
     * A file that does not compile answers no free names, so it says nothing
     * here: the syntax check owns that file until it parses.
     */
    *unresolved(text, file, caret) {
        const answers = this.host.answers ? this.host.answers() : null;
        if (!answers) return;

        let uses;
        try { uses = Application.FreeNames(text); } catch (e) { return; }

        /* The program's answer first, and the text only for what is left:
         * `Lex.blank` was 1.3 s of a 1.7 s pass over `ide/` (Debug) when it ran
         * on every file, and a file whose every free name is answered -- almost
         * all of them -- has nothing to place. */
        uses = uses.filter((u) => !answers.known.has(u.Name) && !this.retired.has(u.Name));
        if (!uses.length) return;

        const code   = Lex.blank(text);
        const asked  = new Set();
        for (const m of TYPEOF_NAME.Matches(code)) asked.add(m.Group(1));

        /* Where each line starts, so a row's line becomes an index the caret
         * and `placeAt` read. */
        const starts = [0];
        for (let i = code.indexOf("\n"); i >= 0; i = code.indexOf("\n", i + 1))
            starts.push(i + 1);

        const said  = new Set();
        let   local = null;

        for (const use of uses) {
            const name = use.Name;
            if (answers.known.has(name) || this.retired.has(name) || asked.has(name))
                continue;
            const key = `${name}:${use.Line}`;
            if (said.has(key)) continue;
            said.add(key);

            /* The word on its line, in the blanked text so a mention in a
             * comment or a string on the same line is not the one marked. A
             * row the line does not show -- a name in a template hole -- is
             * still said, on the line, with no word. */
            const from = starts[use.Line - 1] || 0;
            const to   = use.Line < starts.length ? starts[use.Line] : code.length;
            const word = new Regex(`(^|[^A-Za-z0-9_$.])(${Regex.Escape(name)})(?![A-Za-z0-9_$])`)
                             .Match(code.slice(from, to));
            const index = word ? from + word.Index + (word.Group(1) || "").length : from;
            if (word && caret >= 0 && caret >= index && caret <= index + name.length)
                continue;

            const at = word ? placeAt(text, index, name.length)
                            : { line: use.Line, column: 0, length: 0 };
            let sentence;

            if (answers.kept && answers.kept.has(name)) {
                const where = answers.kept.get(name).map(shownPath).join(" and ");
                sentence = `${name} is declared in ${where} and not exported: ` +
                           `export it there, or this line is a ReferenceError when it runs`;
            } else {
                if (!local) local = this.nearby(text, answers);
                const near = nearest(name, local);
                sentence = near
                    ? `${name} is not declared anywhere: did you mean ${near}?`
                    : `${name} is not declared anywhere: this line is a ReferenceError ` +
                      `when it runs`;
            }

            yield {
                kind: "Warning",
                file,
                line: at.line,
                column: at.column,
                length: at.length,
                text: sentence,
            };
        }
    }

    /* The names a misspelling could have meant: what the program publishes,
     * what the runtime installs, and what this file declares itself --
     * locals included, because `totl` is usually `total` three lines up. */
    nearby(text, answers) {
        const out = new Set(answers.known);

        if (!this.globals) this.globals = Application.Globals();
        for (const g of this.globals) out.add(g);
        try {
            for (const s of Application.Symbols(text))
                if (s.Kind === "Variable" || s.Kind === "Function" ||
                    s.Kind === "Class" || s.Kind === "Import")
                    out.add(s.Name);
        } catch (e) { /* no symbols, no suggestions */ }
        return out;
    }

    /*
     * `this.Btn.Txt`: a member the control's class does not have.
     *
     * The test is the `in` operator on a real control of that type, which is
     * exact where a list of property names would not be -- `Click` and
     * `SetFocus` are methods and are on the prototype, so `PropertyNames()`
     * would report every method call in the project as a mistake.
     */
    *members(text, controls, file, caret) {
        /* The same `Lex.blank` as `curated`: `"this.Twice.Txt"` inside a string
         * is text a program prints, not a member somebody assigned, and the
         * check that reports it is the check people switch off. Offsets and
         * lines are the original's, which is what blanking keeps. */
        const code = Lex.blank(text);

        for (const m of NAMES_MEMBER.Matches(code)) {
            if (underCaret(m, caret)) continue;

            const type = typeOf(controls, m.Group(1));
            if (!type) continue;

            /*
             * A class this process can answer for is asked **by name**, with
             * no control built. A component of the project is not a class of
             * *this* process, so there is nothing here to ask and nothing is
             * reported about it, which is a refusal to guess rather than a gap.
             */
            if (this.runtimeType(type)) {
                if (Widget.Member(type, m.Group(2)) !== "") continue;
            } else {
                continue;
            }

            const at = placeAt(text, m.Index, m.Value.length);

            yield {
                kind: "Warning",
                file,
                line: at.line,
                column: at.column,
                length: at.length,
                text: `${type} has no ${m.Group(2)}: the assignment would be accepted ` +
                      `and do nothing`,
            };
        }
    }

    /*
     * `Btn_Clik()`: a handler for an event the control does not raise.
     *
     * Only where the name before the underscore **is** a control of this form:
     * `Btnn_Click` -- the control misspelled rather than the event -- is a
     * method this cannot tell from any other method with an underscore in it,
     * and warning about those is how a check gets switched off.
     *
     * This is the one that found two real ones in the IDE's own dialogs, where
     * a `ComboBox`'s handler was written `_Change` and a `ComboBox` raises
     * `Select`: loaded, never called, and nothing said so.
     */
    *handlers(text, controls, file, caret) {
        /* A handler is code at the start of a line; a line of prose that looks
         * like one is not. `orphan` still gets the raw text, because what it
         * looks for -- the quoted name a control was built with -- is a string
         * on purpose. */
        const code = Lex.blank(text);

        for (const m of NAMES_HANDLER.Matches(code)) {
            if (underCaret(m, caret)) continue;

            const start  = m.Index + m.Value.indexOf(m.Group(1));
            const at     = placeAt(text, start,
                                   m.Group(1).length + 1 + m.Group(2).length);
            const type   = typeOf(controls, m.Group(1));

            if (!type) {
                const orphan = this.orphan(text, m.Group(1), m.Group(2));
                if (orphan)
                    yield { kind: "Warning", file, line: at.line,
                            column: at.column, length: at.length,
                            text: orphan };
                continue;
            }
            const events = this.eventsOf(type);
            if (!events || events.includes(m.Group(2))) continue;

            yield {
                kind: "Warning",
                file,
                line: at.line,
                column: at.column,
                length: at.length,
                text: `${type} does not raise ${m.Group(2)}: this method will never ` +
                      `be called`,
            };
        }
    }

    /*
     * `Btn1_Click()` after `Btn1` was renamed or deleted: a handler for a
     * control the form no longer has.
     *
     * The paragraph above refuses `Btnn_Click` as indistinguishable from any
     * method with an underscore in it, and for *any* method it is. What makes
     * this one answerable is the second half: only a word **some control
     * raises** -- `Click`, `Change`, `Select` -- is read as an event, which is
     * the shape no helper method is given by accident. And a name the project
     * spells as a string or assigns as `this.Name =` is a control built in
     * code, which binds by `Name` like a declared one, so it is left alone.
     * `Check` hands in the whole project's set; the same-file pattern below is
     * the answer for a caller that has only the file on screen.
     * `Form_` is the form's own and never a control.
     */
    orphan(text, name, event) {
        if (name === "Form") return "";
        if (!this.raisedEvents().has(event)) return "";

        if (this.builtNames && this.builtNames.has(name)) return "";

        const built = new Regex(
            `["'\`]${name}["'\`]|\\bthis\\.${name}[ \\t]*=[^=]`);
        if (built.IsMatch(text)) return "";

        return `no control is named ${name}: ${name}_${event} will never be called`;
    }

    /* Every event some runtime class raises, worked out once: the class list
     * does not change while the IDE runs.  A command's `Execute` is the one a
     * widget does not raise. */
    raisedEvents() {
        if (this.allEvents) return this.allEvents;

        const all = new Set(["Execute"]);
        const types = [...this.widgets, MENU_ITEM_TYPE, ACTION_TYPE];

        for (const type of types)
            for (const ev of Widget.EventNames(type) || []) all.add(ev);
        this.allEvents = all;
        return all;
    }

    /* --- what a type really has ---------------------------------------------- */

    /* The events a class of that type raises, or null when this process cannot
     * build one. Every runtime class answers by name -- a `MenuItem` and an
     * `Action` included, since the runtime builds their class for this question
     * -- and a component answers from what the host can read of its source. */
    eventsOf(type) {
        if (!type) return null;
        if (this.runtimeType(type)) return Widget.EventNames(type);

        return this.host.componentEvents ? this.host.componentEvents(type) : null;
    }

    /*
     * Every name a `.form` puts on its form, flattened, as the table these take.
     *
     * A control is addressed by name whatever it is nested in, because a handler
     * is `Name_Event` on the form and names are unique across it -- and the same
     * mistake two controls of one name is, `Check` reports from this list.
     *
     * **`children` is not the whole of it, and for four flatteners it was not.**
     * A `.form` names something and binds it on the form by that name in four
     * places -- `children`, `menus` (nested again through `children` of its
     * own), `actions`, and a control's own `Menu` property -- and only the first
     * was walked. So `this.MnuSave.` proposed nothing, `MnuSave_Clik()` went
     * unremarked, and a menu item sharing a control's name was a collision
     * nothing looked for. The three blocks carry no `type` in the file because
     * there is only one thing each can be; a control's `Menu` is the same kind
     * of thing -- menu items, one per entry -- which is what `MENU_ITEM_TYPE`
     * says.
     */
    tableOf(root) {
        const out = [];
        const walk = (nodes, type) => {
            for (const node of nodes || []) {
                if (node.name) out.push({ name: node.name, type: type || node.type });
                walk(node.children, type);
            }
        };
        /* The menu a control shows from its own press is a property of the
         * control, not a block of the form, so the three walks above cannot see
         * it. It binds by name on the form exactly as a root menu does. */
        const menus = (nodes) => {
            for (const node of nodes || []) {
                const items = node.properties && node.properties.Menu;

                if (Array.isArray(items)) walk(items, MENU_ITEM_TYPE);
                else if (items && typeof items === "object") walk([items], MENU_ITEM_TYPE);

                menus(node.children);
            }
        };

        walk(root && root.children, "");
        walk(root && root.menus, MENU_ITEM_TYPE);
        walk(root && root.actions, ACTION_TYPE);
        menus(root && root.children);
        return out;
    }
}

/* What the two blocks a `.form` declares beside its controls are made of. Not a
 * `type` anybody writes: `menus` holds menu items and `actions` holds commands,
 * and there is nothing else either could hold. */
const MENU_ITEM_TYPE = "MenuItem";
const ACTION_TYPE    = "Action";

/* The type of the control with that name, or `""` when the form has none. */
function typeOf(controls, name) {
    const found = controls.find((c) => c.name === name);
    return found ? found.type : "";
}

/* Whether the cursor is inside this match, which is what says *still being
 * typed*. One past the end counts: the caret sits there while the last character
 * of a word is the one just pressed. A `caret` of -1 is inside nothing. */
function underCaret(m, caret) {
    return caret >= 0 && caret >= m.Index && caret <= m.Index + m.Value.length;
}

/* The word ending where a match begins, or `""` -- which is how a declaration is
 * told from a call without re-running a pattern over the file.
 *
 * **Trimmed**, because the pattern takes the space between a word and its
 * subject and `DECLARING` is anchored at both ends: `function setTimeout(fn)`
 * answered `"function "`, which is not one of the five words and left the
 * declaration reported as a call. The bug was older than the check that found
 * it -- the assertion that should have caught it was passing against a file the
 * pass never read. */
function wordBefore(text, index) {
    return (text.slice(0, index).match(WORD_BEFORE) || [""])[0].trim();
}


/* How many parameters a `(a, b = 1)` list declares: its top-level commas. */
function paramCount(list) {
    let inner = `${list || ""}`.trim();
    if (inner.startsWith("(")) inner = inner.slice(1);
    if (inner.endsWith(")")) inner = inner.slice(0, -1);
    inner = inner.trim();
    if (!inner) return 0;
    let depth = 0, n = 1;
    for (const ch of inner) {
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        else if (ch === "," && depth === 0) n++;
    }
    return n;
}
