/*
 * Where a name is used, and moving it everywhere it means the same thing.
 *
 * F12 answers *where is this declared*; this answers the other half of the
 * same question -- **where else is it** -- which is the one a rename needs and
 * the one a person asks before touching a name at all. `Ide.Navigator`'s
 * doctrine holds here word for word: table lookups and the parser's answers,
 * never inference, and a refusal said out loud where an answer would be a
 * guess.
 *
 * **A reference is a word in code, and `Ide.Lex` is what says which words are
 * code.** A mention in a comment or in a string is not a reference, and a
 * rename that moved one would be renaming prose -- which is why the scanner
 * exists and why this module is small.
 *
 * **What the rename refuses is the design, not a gap.** A JavaScript file with
 * no resolver cannot tell `this.greet` from `other.greet`, and a rename that
 * rewrote every `greet` would be right until the day two objects shared a name
 * -- and the failure is a program that still runs and does the wrong thing,
 * which is the one outcome worse than refusing. So the shapes are enumerated,
 * anything else is a refusal that names the file and the line, and what can be
 * renamed is what the project *declares*: a class, a top-level function or a
 * method.
 *
 * Controls are deliberately not here. A control's name is the `.form`'s and
 * its handlers follow it -- `Designer.renameControl` already carries both, and
 * a second implementation of that is the second answer this tree keeps
 * refusing to write.
 */
"use strict";

Namespace("Ide");

/* What a name can be: the parser's own rule for an identifier, and nothing
 * else. Both sides of a rename go through it, because `to` becomes the text of
 * a file. */
const REFACTOR_WORD = /^[A-Za-z_$][\w$]*$/;

/* The kinds `Application.Symbols` reports that name something a rename can
 * move. `Variable` is not one: a local belongs to a scope this cannot see. A
 * `Static` is not either: it is reached as a member of its class, and the
 * receiver of `Class.Make` is not something this can attribute -- the same
 * shape a method rename refuses, one level up. */
const REFACTOR_DECLS = ["Class", "Function", "Method", "Getter", "Setter",
                        "Static", "StaticGetter", "StaticSetter"];

/* And the ones that are members of their class rather than of an instance:
 * found as declarations, so the refusal can name what it is, and never
 * rewritten -- `Class.Make` is a member access whose receiver is not something
 * this can attribute. */
const REFACTOR_STATICS = ["Static", "StaticGetter", "StaticSetter"];

/* And of those, the ones that are reached through `this.` -- a method, and the
 * two halves of a property declared with `get`/`set`, which are one name and
 * two declarations. */
const REFACTOR_MEMBERS = ["Method", "Getter", "Setter"];

Ide.Refactor = class Refactor {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;
    }

    /* --- reading ------------------------------------------------------------ */

    /*
     * What a `.js` says **now**: the open tab's editor, or the file. `null`
     * for a name that cannot be read at all.
     *
     * The tab first, and for the reason every reader in this IDE does it: a
     * name written a moment ago and not saved is still a name, and a rename
     * that missed it would leave the file and the screen disagreeing.
     */
    sourceOf(name) {
        const state = this.ide.openTabs.get(name);
        if (state && state.editor) return state.editor.Text;

        try {
            return File.Load(File.Join(this.ide.project, name));
        } catch (e) {
            return null;              /* gone, or not text this IDE may rewrite */
        }
    }

    /*
     * The project's own `.js`, the ones `sources` names and the loose ones
     * alike -- and **not the libraries it uses**: a library is code the project
     * keeps for other projects too, and a rename that reached into one would
     * edit it behind every one of them. `Classes.inLibrary` is the same
     * question the tree asks to file a component under its library tab, so the
     * two cannot disagree about what a library is.
     */
    jsFiles() {
        return this.ide.classes.files.filter(
            (f) => File.IsExtension(f, "js") && !this.ide.classes.inLibrary(f));
    }

    /*
     * A whole word, and `$` is why this is not `\b`.
     *
     * The engine's boundary treats `$` as a non-word character, so `\bgreet\b`
     * matches inside `$greet` -- and this language's identifiers may hold a
     * `$`, which makes that a name of its own. The guards are spelled out, and
     * the left one is captured because a match at the start of a line has no
     * character in front of it.
     */
    wordPattern(word) {
        return new Regex(
            `(^|[^A-Za-z0-9_$])${Regex.Escape(word)}(?![A-Za-z0-9_$])`,
            { Multiline: true });
    }

    /*
     * Every occurrence of the word in one file's *code*, each with the line and
     * the text of the line it is on.
     *
     * `Ide.Lex.blank` is what makes a comment and a string a space: the answer
     * has the file's own length and line breaks, so the offset found in it is
     * the offset in the original and nothing has to be translated.
     */
    occurrences(name, word) {
        const source = this.sourceOf(name);
        if (source === null) return [];

        const code = Ide.Lex.blank(source);
        const out  = [];

        for (const m of this.wordPattern(word).Matches(code)) {
            const at   = m.Index + m.Value.indexOf(word);
            const line = Text.LineOf(source, at);
            out.push({ File: name, Line: line, At: at,
                       Text: (source.split("\n")[line - 1] || "").trim() });
        }
        return out;
    }

    /*
     * The line each declaration of the word sits on, by kind and by the class
     * it is in, for one file. Only asked of a file that already holds an
     * occurrence.
     *
     * The class is `Parent`, which is what tells a method and its get/set pair
     * apart from a same-named method of another class -- the question the
     * rename has to answer before it may touch `this.` anywhere.
     */
    declarationsIn(name, word) {
        const source = this.sourceOf(name);
        if (source === null) return new Map();

        const out = new Map();
        for (const s of Application.Symbols(source))
            if (s.Name === word && REFACTOR_DECLS.includes(s.Kind))
                out.set(s.Line, { kind: s.Kind, parent: s.Parent || "" });

        return out;
    }

    /*
     * What a `.form` says under that name, as rows: a node's own name -- the
     * declaration of a control -- and a node's `type`, which is a class placed
     * as a control and therefore a use of that class.
     *
     * `Ide.Names.tableOf` is the one walk over the three blocks a form names
     * things in, so a menu item and a command are here too.
     */
    formDeclarations(word) {
        const out = [];

        for (const file of this.ide.classes.files) {
            if (!File.IsExtension(file, "form") ||
                this.ide.classes.inLibrary(file))
                continue;

            let root;
            try { root = File.LoadJson(File.Join(this.ide.project, file)); }
            catch (e) { continue; }

            for (const node of this.ide.names.tableOf(root)) {
                if (node.name === word)
                    out.push({ File: file, Line: 0, At: -1, Decl: "Control",
                               Text: `${node.type} ${node.name}` });
                else if (node.type === word)
                    out.push({ File: file, Line: 0, At: -1, Type: node.type,
                               Text: `placed as ${node.name}` });
            }
        }
        return out;
    }



    /*
     * Every reference to the word, in the project, **the declarations first**.
     *
     * A row is `{ File, Line, Text, Decl }`, and `Decl` is the kind when the
     * line declares the name -- `Class`, `Function`, `Method` or `Control` --
     * and absent when it only uses it. Declarations first and then the file
     * and the line, because that is the order a person reads a list of places
     * in: what it is, then where it is used.
     */
    references(word) {
        const rows = this.formDeclarations(word);

        for (const name of this.jsFiles()) {
            const found = this.occurrences(name, word);
            if (!found.length) continue;

            const decl = this.declarationsIn(name, word);
            for (const row of found) {
                const at = decl.get(row.Line);
                if (at) { row.Decl = at.kind; row.Parent = at.parent; }
            }
            rows.push(...found);
        }

        return rows.sort((a, b) => {
            if (!!a.Decl !== !!b.Decl) return a.Decl ? -1 : 1;
            const byFile = Locale.Compare(a.File, b.File);
            return byFile !== 0 ? byFile : a.Line - b.Line;
        });
    }

    /* --- writing ------------------------------------------------------------ */

    /*
     * The word replaced by `to` in one text, counted. The blanked copy decides
     * *where*, and the original is what is written back -- the spaces the
     * scanner left are not the file's.
     */
    replaceIn(source, word, to) {
        const code = Ide.Lex.blank(source);
        let out = "", at = 0, moved = 0;

        for (const m of this.wordPattern(word).Matches(code)) {
            const i = m.Index + m.Value.indexOf(word);
            out += source.slice(at, i) + to;
            at   = i + word.length;
            moved++;
        }
        return { text: out + source.slice(at), moved };
    }

    /*
     * Rename `word` to `to` across the project, or refuse and say why.
     *
     * Answers `{ Moved, Files }` when it wrote, and `{ Refused }` with a
     * sentence when it did not -- a rename is a rewrite of somebody's source
     * and a silent half of one is the failure this whole module is arranged
     * against. Nothing is written before every refusal has been checked.
     */
    rename(word, to) {
        if (!REFACTOR_WORD.test(word || ""))
            return { Refused: "Put the cursor on a name first." };
        if (!REFACTOR_WORD.test(to || ""))
            return { Refused: `"${to}" is not a name -- letters, digits, _ and $, and not starting with a digit.` };
        if (word === to)
            return { Refused: "The new name is the same as the old one." };

        const rows = this.references(word);
        const decl = rows.find((r) => r.Decl);

        if (!decl)
            return { Refused: `Nothing in this project declares ${word} -- only a class, a function or a method can be renamed.` };
        if (decl.Decl === "Control")
            return { Refused: `${word} is a control: rename it from the designer, which carries its handlers along.` };
        if (REFACTOR_STATICS.includes(decl.Decl))
            return { Refused: `${word} is a static of ${decl.Parent || "a class"} -- this cannot tell which class a member access belongs to.` };
        if (decl.Decl === "Class" && this.ide.classes.formOf(decl.File))
            return { Refused: `${word} is a form -- F2 renames it, and moves its .form, its tab and project.json with it.` };

        /* A class a form places as a control is a use in a `.form`, and the
         * forms are rewritten rather than reported: they are JSON the IDE owns
         * the shape of, and `retypeForms` is the same road F2 already takes. */
        const placed = rows.find((r) => !r.Decl && r.At < 0 &&
                                        r.Text.startsWith("placed as"));

        /* What is already called that. A declaration anywhere, or a control --
         * either one makes the new name mean two things. */
        const taken = this.references(to).find((r) => r.Decl);
        if (taken)
            return { Refused: `${to} is already declared in ${taken.File}${taken.Line ? `:${taken.Line}` : ""}.` };

        /* And the libraries, whose top-level names share the program's one
         * scope: a class of the project renamed onto one of theirs is a
         * redeclaration, and the program does not start. They are read and not
         * rewritten, which is exactly why this has to ask. */
        if (this.libraryDeclares(to))
            return { Refused: `${to} is a class of a library this project uses -- the two would collide at load.` };

        const isMethod = REFACTOR_MEMBERS.includes(decl.Decl);

        /* A member declared in two classes is two members that share a name,
         * and `this.greet` in a third file would not say which one it means.
         * Counted by class and not by row, because a property declared with
         * `get` and `set` is one name and two declarations. */
        if (isMethod) {
            const classes = new Set(
                rows.filter((r) => REFACTOR_MEMBERS.includes(r.Decl))
                    .map((r) => r.Parent || r.File));
            if (classes.size > 1)
                return { Refused: `${word} is declared in ${classes.size} classes -- this rename cannot tell which one a use means.` };
            if (rows.some((r) => r.Decl === "Control"))
                return { Refused: `A control is called ${word} too, so this.${word} would name two things.` };

            const handler = this.handlerOf(decl.File, word);
            if (handler)
                return { Refused: `${word} is ${handler.control}'s ${handler.event} handler -- rename the control, which carries its handlers along.` };
        }

        /* Every use, against the shapes the kind allows. */
        for (const row of rows) {
            if (row.Decl || row.At < 0) continue;

            const source = this.sourceOf(row.File);
            if (source === null) continue;

            const shape = this.shapeAt(source, row.At, word);

            if (shape === "key")
                return { Refused: `${word} is followed by a colon at ${row.File}:${row.Line} -- a key, a label or a ternary, and not a use this rename can attribute.` };

            if (shape === "bare" && this.shadowsIn(row.File, word))
                return { Refused: `${word} is a local in ${row.File} too -- this rename cannot tell a use from that binding.` };

            if (isMethod) {
                /* `this.greet` is the method; a bare use counts only in the
                 * file that declares it, where the class scope is the one it
                 * resolves in. */
                if (shape === "member")
                    return { Refused: `${word} is a member of another object at ${row.File}:${row.Line} -- this rename cannot tell whose.` };
                if (shape === "bare" && row.File !== decl.File)
                    return { Refused: `${word} is used bare at ${row.File}:${row.Line}, outside the class that declares it.` };
            } else {
                /* A class or a function is a name of the program's own scope:
                 * a use in front of a dot belongs to some object's member. */
                if (shape === "member")
                    return { Refused: `${word} is a member of another object at ${row.File}:${row.Line} -- a rename would change a property that is not this name.` };
            }
        }

        /* A class whose file is named after it moves with it: the file is where
         * a project's class is looked for, and `Safe.js` declaring `Guard` is
         * the kind of half a person finds a week later. Refused before anything
         * is written, so a name that cannot move cannot leave a half rename
         * behind; `renameFile` is the IDE's own road for the move. */
        const movesFile = decl.Decl === "Class" && File.BaseName(decl.File) === word;
        const folder    = File.Directory(decl.File);
        const movedTo   = folder === "." ? `${to}.js` : File.Join(folder, `${to}.js`);
        if (movesFile && File.Exists(File.Join(this.ide.project, movedTo)))
            return { Refused: `${movedTo} already exists.` };

        /* Nothing refused, so every row is written. `rewriteSource` is the one
         * road to a file, so the open tab and the disk move together. */
        const files = [];
        let   moved = 0;

        for (const name of new Set(rows.filter((r) => r.At >= 0).map((r) => r.File))) {
            this.ide.tabs.rewriteSource(name, (source) => {
                const done = this.replaceIn(source, word, to);
                moved += done.moved;
                return done.text;
            });
            files.push(name);
        }

        if (movesFile && this.ide.renameFile(decl.File, movedTo))
            files[files.indexOf(decl.File)] = movedTo;

        /*
         * And the forms that place the class as a control. They are rewritten
         * through `FormFiles.retypeForms` -- the same road F2 takes, which
         * already follows an open designer and a tab with unsaved work -- and
         * not by a second implementation here, which would be the one to get
         * the dirty tab wrong. `newFull` keeps the namespace the form spelled:
         * a class in `Widgets/Stepper.js` is placed as `Widgets.Stepper`.
         */
        if (decl.Decl === "Class" && placed) {
            const oldFull = placed.Type || word;
            const cut     = oldFull.lastIndexOf(".");
            const newFull = cut >= 0 ? oldFull.slice(0, cut + 1) + to : to;

            for (const file of this.ide.formFiles.retypeForms(oldFull, newFull, ""))
                if (!files.includes(file)) files.push(file);
        }

        return { Moved: moved, Files: files };
    }

    /*
     * Whether the method is a control's handler, which is the one method a
     * rename must not touch: the name *is* the binding, the runtime looks it up
     * by `<control>_<event>`, and moving it makes the handler dead code that
     * still looks wired. Answered from the `.form` beside the class and the
     * event list the control's class publishes, so it cannot drift.
     */
    handlerOf(file, word) {
        const form = this.ide.classes.formOf(file);
        if (!form) return null;

        const under = word.indexOf("_");
        if (under <= 0) return null;

        const control = word.slice(0, under);
        const event   = word.slice(under + 1);

        let root;
        try { root = File.LoadJson(File.Join(this.ide.project, form)); }
        catch (e) { return null; }

        const node = this.ide.names.tableOf(root).find((n) => n.name === control);
        if (!node) return null;

        const events = this.ide.names.eventsOf(node.type) || [];
        return events.includes(event) ? { control, event } : null;
    }

    /*
     * Whether any library this project uses declares a top-level class or
     * function of that name. Read, never written: the answer exists so that a
     * rename cannot collide with one.
     */
    libraryDeclares(word) {
        for (const lib of this.ide.classes.libraries || []) {
            let files;
            try {
                files = Directory.Files(lib.dir, { Pattern: "*.js",
                                                   Recursive: true });
            } catch (e) {
                continue;
            }

            for (const file of files) {
                let source;
                try { source = File.Load(file); } catch (e) { continue; }

                if (Application.Symbols(source).some(
                        (s) => s.Name === word &&
                               (s.Kind === "Class" || s.Kind === "Function")))
                    return true;
            }
        }
        return false;
    }

    /*
     * Whether the file declares a local -- a variable or a parameter -- of that
     * name, which is what makes a bare occurrence ambiguous.
     *
     * Conservative on purpose: any declaration anywhere in the file counts,
     * because refusing a rename is cheap and attributing a use to the wrong
     * binding is not. A parameter is read out of the scope's own list, which is
     * the parser's answer to *what does this function take*.
     */
    shadowsIn(name, word) {
        const source = this.sourceOf(name);
        if (source === null) return false;

        for (const s of Application.Symbols(source)) {
            if (s.Kind === "Variable" && s.Name === word) return true;
            if (s.Kind === "Scope" &&
                (s.Params || "").split(/[^A-Za-z0-9_$]+/).includes(word))
                return true;
        }
        return false;
    }

    /*
     * The shape of the occurrence at `at`: `this`, `member`, `key` or `bare`.
     *
     * Read from the original text, because the blanked copy has already turned
     * the dot of `this.greet` into a space -- and the character after the word
     * is what tells a key from a use.
     */
    shapeAt(source, at, word) {
        const before = source.slice(Math.max(0, at - 6), at);
        if (/\.$/.test(before))
            return /\bthis\.$/.test(before) ? "this" : "member";

        const after = source.slice(at + word.length);
        if (/^[ \t]*:/.test(after) && !/^[ \t]*::/.test(after))
            return "key";

        return "bare";
    }
};
