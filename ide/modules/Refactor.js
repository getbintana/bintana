/*
 * Where a name is used, and moving it everywhere it means the same thing.
 *
 * F12 answers *where is this declared*; this answers the other half of the
 * same question -- **where else is it** -- which is the one a rename needs and
 * the one a person asks before touching a name at all. `Navigator`'s
 * doctrine holds here word for word: table lookups and the parser's answers,
 * never inference, and a refusal said out loud where an answer would be a
 * guess.
 *
 * **A reference is a word in code, and `Lex` is what says which words are
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
                        "Static", "StaticGetter", "StaticSetter", "Field"];

/* And the ones that are members of their class rather than of an instance:
 * found as declarations, so the refusal can name what it is, and never
 * rewritten -- `Class.Make` is a member access whose receiver is not something
 * this can attribute. */
const REFACTOR_STATICS = ["Static", "StaticGetter", "StaticSetter"];

/* And of those, the ones that are reached through `this.` -- a method, and the
 * two halves of a property declared with `get`/`set`, which are one name and
 * two declarations. */
const REFACTOR_MEMBERS = ["Method", "Getter", "Setter"];

export class Refactor {

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
     * `Lex.blank` is what makes a comment and a string a space: the answer
     * has the file's own length and line breaks, so the offset found in it is
     * the offset in the original and nothing has to be translated.
     */
    occurrences(name, word) {
        const source = this.sourceOf(name);
        if (source === null) return [];

        const code = Lex.blank(source);
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
     * The binding a use at `at` resolves to, or `null` when it is not a local
     * or a parameter.
     *
     * **The parser's `Scope` is the whole of the model**: every function with
     * its line span and its parameter list, and every `Variable` at its line.
     * A variable belongs to the innermost scope that contains its line (or to
     * the file, when no function does), and a use resolves to the innermost
     * scope around it that declares the name -- walking outward, so a nested
     * function that declares its own `sum` wins over the outer one.
     *
     * Block scopes are not reported by the parser, so a `let` inside an `if`
     * is attributed to its function. That is the conservative direction for a
     * rename: it may move a use outside the block, never one inside another
     * binding's.
     */
    bindingAt(source, word, at, symbols) {
        const line = Text.LineOf(source, at);
        const syms = symbols || Application.Symbols(source);
        const scopes = syms.filter((s) => s.Kind === "Scope" && s.End > 0)
                           .sort((a, b) => a.Line - b.Line);

        const within = (scope, l) => l >= scope.Line && l <= scope.End;
        const inner  = (l) => {
            let found = null;
            for (const scope of scopes)
                if (within(scope, l) && (!found || scope.Line > found.Line))
                    found = scope;
            return found;
        };
        const params = (scope) =>
            (scope.Params || "").split(/[^A-Za-z0-9_$]+/).includes(word);

        const variableOf = (scope) => syms.find((s) =>
            s.Kind === "Variable" && s.Name === word && within(scope, s.Line) &&
            inner(s.Line) === scope);

        /* Innermost first: the first scope around the use that declares the
         * name is the binding the use means. */
        const around = scopes.filter((s) => within(s, line))
                             .sort((a, b) => b.Line - a.Line);
        for (const scope of around) {
            const param    = params(scope);
            const variable = variableOf(scope);
            if (param || variable)
                return { kind: param ? "param" : "var",
                         scope: scope.Line, name: word,
                         blocked: variable ? this.blockedVariable(source, variable, scope)
                                           : false };
        }

        /* No function around it: a top-level `let`/`const`/`var` is the
         * file's binding, and nothing else in the file may move with it. */
        const top = syms.find((s) => s.Kind === "Variable" && s.Name === word &&
                                     !inner(s.Line));
        if (top)
            return { kind: "var", scope: 0, name: word,
                     blocked: this.blockedVariable(source, top, null) };

        return null;
    }

    /*
     * Whether the variable is one a block narrows.
     *
     * `Scope` is a function, and a `let`/`const` inside an `if`, a `for` or a
     * catch belongs to the block, not to the function. Moving a use outside
     * the block would be a wrong edit that still runs, so those are refused:
     * the parser does not report block scopes, and a brace count is enough to
     * know that it cannot be attributed. A `var` is function-scoped and stays
     * safe wherever it is written.
     */
    blockedVariable(source, variable, scope) {
        const line = (source.split("\n")[variable.Line - 1] || "");
        if (!/\b(let|const)\b/.test(line))
            return /\bcatch\b/.test(line);   /* a catch binding is block-scoped */

        if (/\b(for|if|while|switch|catch)\b/.test(line))
            return true;

        const limit = scope ? 1 : 0;
        return this.blockDepth(source, scope ? scope.Line : 1, variable.Line) > limit;
    }

    /* Braces opened between two lines, on the blanked source so a brace in a
     * string or a comment is not one. */
    blockDepth(source, from, to) {
        const lines = Lex.blank(source).split("\n");
        let   depth = 0;

        for (let l = from - 1; l < to - 1; l++)
            for (const ch of lines[l] || "") {
                if (ch === "{") depth++;
                else if (ch === "}") depth--;
            }
        return depth;
    }

    /* Whether the file declares the name at all, in any kind or scope -- the
     * collision question a local rename asks before writing. */
    declaresIn(symbols, name) {
        for (const s of symbols) {
            if (s.Name === name &&
                (s.Kind === "Variable" || REFACTOR_DECLS.includes(s.Kind)))
                return true;
            if (s.Kind === "Scope" &&
                (s.Params || "").split(/[^A-Za-z0-9_$]+/).includes(name))
                return true;
        }
        return false;
    }

    /*
     * Rename one binding and only its uses. The file is the only one a local
     * can live in; `replaceRows` writes the occurrences the resolver chose, so
     * a same-named local in another function is left exactly as it was.
     */
    renameLocal(file, source, word, to, binding, symbols) {
        if (binding.blocked)
            return { Refused: `${word} is declared in a block -- this rename cannot tell its uses from the block's.` };
        if (this.declaresIn(symbols, to))
            return { Refused: `${to} is already declared in ${file}.` };

        const rows = this.occurrences(file, word).filter((row) => {
            const at = this.bindingAt(source, word, row.At, symbols);
            return at && at.kind === binding.kind && at.scope === binding.scope;
        });

        if (!rows.length)
            return { Refused: `Nothing in this scope uses ${word}.` };

        let moved = 0;
        this.ide.tabs.rewriteSource(file, (text) => {
            const done = this.replaceRows(text, word, to, rows);
            moved = done.moved;
            return done.text;
        });
        return { Moved: moved, Files: [file] };
    }

    /* The occurrences at these offsets, and only these, replaced. */
    replaceRows(source, word, to, rows) {
        let out = "", at = 0, moved = 0;

        for (const row of rows.slice().sort((a, b) => a.At - b.At)) {
            if (row.At < at) continue;
            out += source.slice(at, row.At) + to;
            at   = row.At + word.length;
            moved++;
        }
        return { text: out + source.slice(at), moved };
    }

    /*
     * The declaration the caret means. A line that declares the name answers
     * first; a `this.name` use answers with the field of the class the method
     * belongs to; anything else falls back to the first declaration, which is
     * the project-wide rule the other kinds have always used.
     */
    declarationAt(rows, word, where) {
        if (where && where.file && where.at !== undefined) {
            const source = this.sourceOf(where.file);
            if (source !== null) {
                const line = Text.LineOf(source, where.at);
                const here = rows.find((r) => r.Decl && r.File === where.file &&
                                               r.Line === line);
                if (here) return here;

                if (this.shapeAt(source, where.at, word) === "this") {
                    const syms  = Application.Symbols(source);
                    const owner = this.classOfUse(source, line, syms);

                    /* `this.name` in a static method is the class's own field,
                     * which this parser does not report; the refusal is the
                     * existing static one. */
                    if (owner && !owner.instance)
                        return { Decl: "Static", File: where.file, Line: line,
                                 Parent: owner.parent };

                    if (owner) {
                        const field = rows.find((r) => r.Decl === "Field" &&
                            r.File === where.file &&
                            (r.Parent === owner.parent ||
                             this.isSubclass(syms, owner.parent, r.Parent)));
                        if (field) return field;
                        return { Decl: "FieldMissing", File: where.file,
                                 Line: line, Parent: owner.parent };
                    }

                    /* A nested function or a field initializer: the field is
                     * in this file, and `renameField` refuses the use. */
                    const field = rows.find((r) => r.Decl === "Field" &&
                                                   r.File === where.file);
                    if (field) return field;
                    return { Decl: "FieldMissing", File: where.file,
                             Line: line, Parent: "" };
                }
            }
        }

        if (where && where.file) {
            const same = rows.find((r) => r.Decl && r.File === where.file);
            if (same) return same;
        }
        return rows.find((r) => r.Decl) || null;
    }

    /*
     * The class a `this.name` use belongs to, or `null` when it is not directly
     * in a method.
     *
     * The innermost `Scope` is the method only when the use is in its body; an
     * arrow or a nested function is a scope of its own with no `Method` at its
     * line, and `this` there is not necessarily the class. Those are refused
     * rather than guessed. A static method is the class's `this`, not the
     * instance's, and is marked so a field rename can leave it alone.
     */
    classOfUse(source, line, symbols) {
        const syms   = symbols || Application.Symbols(source);
        const scopes = syms.filter((s) => s.Kind === "Scope" &&
                                          s.Line <= line && s.End >= line)
                           .sort((a, b) => b.Line - a.Line);
        const scope  = scopes[0];
        if (!scope) return null;

        const member = syms.find((s) => s.Line === scope.Line &&
            (s.Kind === "Method" || s.Kind === "Getter" || s.Kind === "Setter" ||
             s.Kind === "Static" || s.Kind === "StaticGetter" ||
             s.Kind === "StaticSetter"));
        if (!member) return null;

        return { parent: member.Parent || "",
                 instance: REFACTOR_MEMBERS.includes(member.Kind) };
    }

    /* Whether `child` is `parent` or extends it, by the parser's `Super` chain.
     * A heritage that is an expression has no name and ends the walk. */
    isSubclass(symbols, child, parent) {
        for (let at = child, guard = 0; at && guard < 32; guard++) {
            if (at === parent) return true;
            const cls = symbols.find((s) => s.Kind === "Class" && s.Name === at);
            at = cls ? (cls.Super || "") : "";
        }
        return false;
    }

    /*
     * A class field: the declaration and the `this.name` uses of its class.
     *
     * A bare `name` is a local or a global and not the field, and `other.name`
     * is another object's; both are left exactly as they were. A `this.name` in
     * another class is another field, and one in a static method is the class's
     * own -- neither moves. A `this.name` that cannot be attributed (a nested
     * function, a field initializer) is a refusal, because a missed use is a
     * wrong rename that still runs.
     */
    renameField(word, to, decl, rows) {
        if (!decl.Parent)
            return { Refused: `${word} is a field of an anonymous class -- this cannot name the class a use belongs to.` };

        const source = this.sourceOf(decl.File);
        if (source === null)
            return { Refused: `${decl.File} cannot be read.` };

        const syms = Application.Symbols(source);
        const taken = syms.find((s) => s.Name === to && s.Parent === decl.Parent &&
            (s.Kind === "Field" || REFACTOR_DECLS.includes(s.Kind)));
        if (taken)
            return { Refused: `${to} is already a member of ${decl.Parent}.` };

        const selected = [];
        for (const row of rows) {
            if (row.File !== decl.File) continue;

            if (row.Decl) {
                if (row.Decl === "Field" && row.Line === decl.Line)
                    selected.push(row);
                continue;
            }

            if (this.shapeAt(source, row.At, word) !== "this") continue;

            const owner = this.classOfUse(source, row.Line, syms);
            if (!owner)
                return { Refused: `this.${word} at ${row.File}:${row.Line} is not directly in a method -- this cannot tell what it means.` };
            if (!owner.instance) continue;

            if (owner.parent === decl.Parent) {
                selected.push(row);
            } else if (this.isSubclass(syms, owner.parent, decl.Parent)) {
                /* The inherited field, unless the subclass declares one of its
                 * own -- then `this.word` there is that other field. */
                const own = syms.some((s) => s.Kind === "Field" &&
                                             s.Parent === owner.parent &&
                                             s.Name === word);
                if (!own)
                    return { Refused: `this.${word} at ${row.File}:${row.Line} uses ${decl.Parent}'s field from ${owner.parent} -- this cannot rename an inherited use safely.` };
            }
        }

        if (!selected.some((r) => r.Decl))
            return { Refused: `Nothing in ${decl.Parent} declares ${word}.` };

        let moved = 0;
        this.ide.tabs.rewriteSource(decl.File, (text) => {
            const done = this.replaceRows(text, word, to, selected);
            moved = done.moved;
            return done.text;
        });
        return { Moved: moved, Files: [decl.File] };
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
     * `Names.tableOf` is the one walk over the three blocks a form names
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
        const code = Lex.blank(source);
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
    rename(word, to, where) {
        if (!REFACTOR_WORD.test(word || ""))
            return { Refused: "Put the cursor on a name first." };
        if (!REFACTOR_WORD.test(to || ""))
            return { Refused: `"${to}" is not a name -- letters, digits, _ and $, and not starting with a digit.` };
        if (word === to)
            return { Refused: "The new name is the same as the old one." };

        /* A local, a parameter or a file-level `let` is a binding a scope can
         * name; the caret says which one, and the rename moves only the uses
         * that resolve to it. Without a position the old project-wide answer is
         * the only one there is, and a local is still refused there. */
        if (where && where.file && where.at !== undefined) {
            const source = this.sourceOf(where.file);
            if (source !== null) {
                try {
                    const symbols = Application.Symbols(source);
                    const binding = this.bindingAt(source, word, where.at, symbols);
                    if (binding)
                        return this.renameLocal(where.file, source, word, to,
                                                binding, symbols);
                } catch (e) {
                    /* A file that does not parse is not a binding to move;
                     * the project-wide answer below will refuse by name. */
                }
            }
        }

        let   rows = this.references(word);
        const decl = this.declarationAt(rows, word, where);

        if (!decl)
            return { Refused: `Nothing in this project declares ${word} -- only a class, a function or a method can be renamed.` };
        if (decl.Decl === "Control")
            return { Refused: `${word} is a control: rename it from the designer, which carries its handlers along.` };
        if (REFACTOR_STATICS.includes(decl.Decl))
            return { Refused: `${word} is a static of ${decl.Parent || "a class"} -- this cannot tell which class a member access belongs to.` };
        if (decl.Decl === "FieldMissing")
            return { Refused: `${word} does not name a field of ${decl.Parent || "that class"}.` };
        if (decl.Decl === "Field")
            return this.renameField(word, to, decl, rows);
        if (decl.Decl === "Class" && this.ide.classes.formOf(decl.File))
            return { Refused: `${word} is a form -- F2 renames it, and moves its .form, its tab and project.btp with it.` };

        /*
         * Modules (docs/plans/modules-plan.md): a file with `export` keeps what
         * it does not export, so the same top-level name may be declared by two
         * files and mean two things. One declared by more than one file is
         * refused -- a use elsewhere cannot be told apart -- and one a module
         * declares and does not export is that file's alone, so only that file
         * moves. An exported name moves everywhere, `import { X }` and
         * `export { X as Y }` included, since there it is code like any use.
         */
        if (decl.Decl === "Class" || decl.Decl === "Function") {
            const homes = new Set(rows.filter((r) => r.Decl === "Class" ||
                                                     r.Decl === "Function")
                                      .map((r) => r.File));
            if (homes.size > 1)
                return { Refused: `${word} is declared in ${homes.size} files -- this rename cannot tell which one a use means.` };
            if (this.privateTo(decl.File, word))
                rows = rows.filter((r) => r.File === decl.File);
        }

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
     * Whether a top-level name is a module's own: the file says `export` or
     * `import` somewhere, and no export of its own stands for this name.
     */
    privateTo(file, word) {
        const source = this.sourceOf(file);
        if (source === null) return false;

        const syms = Application.Symbols(source);
        if (!syms.some((s) => s.Kind === "Export" || s.Kind === "Import")) return false;
        return !syms.some((s) => s.Kind === "Export" && !s.From && s.Parent === word);
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
}
