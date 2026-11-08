/*
 * What is wrong with the project, asked of the whole of it.
 *
 * `Live` reads the file on screen, which is one file. Most of what this
 * language accepts in silence is not about the file on screen at all: a `.form`
 * loses a control because another one has its name, a manifest lists a source
 * that is not there, a `.js` sits on disk that nothing loads. Those are just as
 * wrong in a file nobody has open, and until now nothing looked.
 *
 * **Eleven checks, and every one of them was measured before it was written.** Each
 * is a thing the runtime accepts without a word, found by writing it wrong on
 * purpose and watching what happened:
 *
 *     two controls of one name      the first one is gone -- two nodes in the
 *                                   file, one control on the window. A menu item
 *                                   and a command are bound by name too, so the
 *                                   same is true of them
 *     a control named `Actions`     `this.Actions` answers the *form's* actions,
 *                                   so the control has no name at all. The
 *                                   runtime refuses such a form now -- control,
 *                                   menu item and command alike -- so what is
 *                                   left here is saying so before it is run
 *     a property the class lacks    applied, ignored, never mentioned
 *     source that does not compile  refused at the first line, whatever the file
 *                                   is, whether or not a `.form` sits beside it
 *     a `.js` nothing reaches      not loaded -- no `sources` entry and no
 *                                   relative `import`; the symptom is a
 *                                   ReferenceError in another file entirely
 *     a key nothing reads           ignored; `"format"` was in one of this
 *                                   repository's own examples
 *     a member or a handler         `Names`, over every pair, not just the
 *                                   one on screen -- and a handler whose
 *                                   control was renamed or deleted
 *     a call to a name taken away   `setTimeout(fn, 100)` runs into a
 *                                   ReferenceError at the next run, and the
 *                                   replacement was nowhere in the project.
 *                                   `Names` asks the runtime's own table
 *     a name two modules export     loaded, and the use throws naming both
 *                                   at run time; `Names.ambiguous` says
 *                                   it where the word is, unless the file
 *                                   imports it
 *     a name nothing declares       `helpr()`, `totl = 3`: compiled, loaded,
 *                                   and a ReferenceError the day that line
 *                                   runs. `Names.unresolved` reads the
 *                                   compiler's free names against what the
 *                                   program and its libraries publish; the
 *                                   first run over this repository found
 *                                   `examples/clients` deleting a client
 *                                   through a `Confirm` its manifest had lost
 *     a member hiding a control's   `Expand(key)` on a component works until
 *                                   a `.form` says `Expand: true` and the
 *                                   method is gone; `Names.shadowing` holds
 *                                   the project's classes to the rule
 *                                   `tests/api.sh` holds the runtime's to
 *
 * The last four are why `Names` exists apart from `Live`: *does this
 * control have this member* has to have one answer, and a second copy of it
 * would be a second answer to drift from the first — and the last three of them
 * ask about no `.form` at all, so they run over a module too.
 *
 * **It runs no compiler and opens no file in a tab.** `File.LoadJson` and
 * `File.Load` are the whole of what it asks for, which is what keeps a pass over
 * a project cheap enough to run when one is opened -- with two exceptions, the
 * syntax pass below and the unresolved names, which ask the compiler for the
 * answers it is uniquely placed to give: whether a file parses, and which names
 * it leaves to somebody else.
 *
 * Prior art: this is *Build → Check* in Delphi and Lazarus, `Project → Compile`
 * in Visual Basic -- the pass that says what is wrong before you press Run. What
 * this language has instead of a compiler is a `.form` that says what every
 * control is, which turns out to be enough for the mistakes that hurt most.
 */
"use strict";

/*
 * The one import shape the parser's symbol report does not name: `import
 * "./x.js"` has no binding, so `Application.Symbols` answers nothing for it.
 * Read from the raw text, where the path is a string on purpose -- `Lex.blank`
 * would take exactly the path away.
 */
const SIDE_EFFECT_IMPORT = new Regex(
    "\\bimport[ \\t]*[\"']([^\"']+)[\"']", { Multiline: true });

/*
 * The digest of one text: `Hash.Sha256` over its bytes in process. It is the
 * C checksum and not `File.Hash`, which opens every file through GIO and cost
 * seconds on the IDE's own project; the same bytes here cost milliseconds.
 */
function digest(text) {
    return Hash.Sha256(new Bytes(text));
}

export class Check {

    /** @param {object} host a project, its files and names, and where findings go.
     * `{ project, classes: { files, formOf }, names, problems: { report, clear } }`
     * is all this asks of it. The IDE passes itself; `bintana check` passes the
     * console project's own host, so neither has to be the other. */
    constructor(host) {
        this.host = host;

        /* The answer of the last pass, per project. `run()` reports it again
         * when no source or form has changed, which is what makes reopening a
         * project -- including switching A -> B -> A -- instant. The map is
         * small (one list of findings per project opened) and `forget` keeps
         * it: a project being left has nothing to answer for on screen, but
         * its answer is still true when it comes back. */
        this.cache = new Map();
    }

    /* The child's answer, in the cache `run` reads. `CheckJob` has already
     * established that the print still describes the project. */
    remember(print, found) {
        this.cache.set(this.host.project, { print, found });
    }

    /*
     * The project as it is, by content: every `.js`, `.form` and the manifest,
     * path and digest. A listing of sizes and mtimes would be cheaper, and it
     * misses a rewrite that landed in the same millisecond -- exactly what a
     * test does when it saves a fixture and asks again on the next line.
     *
     * The digest is `Hash.Sha256` over the text, in process, and not
     * `File.Hash`: hashing every file through GIO cost three seconds on the
     * IDE's own project, where the same bytes here cost about thirteen
     * milliseconds. The `.js` texts are handed back because `run()` reads them
     * next anyway; a `.form` or the manifest is small and read again where it
     * is parsed.
     */
    scan() {
        const files = (this.host.classes.files || []).slice().sort();
        const texts = new Map();
        const out   = [];

        for (const file of files) {
            const ext = File.Extension(file).toLowerCase();

            if (file !== "project.btp" && file !== "project.json" &&
                ext !== "js" && ext !== "form")
                continue;

            let text;
            try { text = File.Load(File.Join(this.host.project, file)); }
            catch (e) { continue; }         /* `code()` skips it too */

            if (ext === "js") texts.set(file, text);
            out.push(`${file}\t${text.length}\t${digest(text)}`);
        }
        return { texts, print: out.join("\n") };
    }

    /*
     * Whether the loader will *refuse* this name or merely shadow what it
     * lands on.
     *
     * `Widget.Member` answers what the name is on a bare `Form` -- the class,
     * not a window built to ask -- and the loader refuses two kinds: a
     * **read-only** member (`Actions`, `Menus`, `Controls`, `DefaultButton`,
     * `CancelButton`) and a **method** (`Close`, `Show`, `On`), which is not
     * writable since the runtime seals a control's methods. A settable
     * property is what is left, and the collision is all that can be said.
     */
    refusedByForm(name) {
        const kind = Widget.Member("Form", name);
        return kind === "ReadOnly" || kind === "Method";
    }

    /*
     * The pass. Everything it finds goes in under one source, so running it
     * again replaces what it said last time and nothing else -- the rule every
     * source of the Problems panel keeps.
     */
    run() {
        const host = this.host;
        if (!host.project) return [];

        const scan   = this.scan();
        const print  = scan.print;
        const cached = this.cache.get(host.project);

        if (cached && cached.print === print) {
            host.problems.report("project", cached.found);
            return cached.found;
        }

        const found = [];
        this.a11y = "warning";

        /*
         * The `.js` texts `scan()` just read, before anything asks a question
         * that spans files. Two do: the names a control built in code gives
         * itself (so a handler in one file is not called dead because the
         * control is built in another), and the files an explicit `import`
         * loads (so a manifest with a `sources` list is not told a module it
         * imports is never loaded). `code()` below reads the same text from
         * here rather than from disk a second time.
         */
        this.texts = scan.texts;
        if (host.names && host.names.setBuiltNames)
            host.names.setBuiltNames(Names.builtIn([...this.texts.values()]));
        if (host.names && host.names.setClassTree)
            host.names.setClassTree(Names.classTree([...this.texts.values()]));

        this.manifest(found);

        for (const file of host.classes.files) {
            const ext = File.Extension(file).toLowerCase();

            /* One unreadable file is a row about that file, not the end of the
             * pass: a malformed `.form` used to throw here and the tool printed
             * a stack trace with nothing about the file that caused it. */
            try {
                if (ext === "form") this.form(file, found);
                if (ext === "js")   this.code(file, found);
            } catch (e) {
                found.push({ kind: "Error", file, line: 0,
                             text: `the check could not read it: ${e.message}` });
            }
        }

        this.texts = null;

        /* The print is the one the pass read. A source changed from another
         * process while the pass ran is the next run's business: it reads a
         * different print and the pass runs again. Re-scanning here cost a
         * second copy of every source and a collection, for a case the next
         * open already answers. */
        this.cache.set(host.project, { print, found });

        host.problems.report("project", found);
        return found;
    }

    /* Everything this pass said, taken back: a project being closed has nothing
     * to answer for. */
    forget() {
        this.host.problems.clear("project");
    }

    /*
     * The one repair a machine can make without inventing prose: a caption
     * that sits immediately above a field, and no `For` on either side.
     * `finding.fix` is `{ label, field }`, as `Accessibility.entries` wrote it.
     *
     * **One implementation, two callers**: `bintana check --fix` and the IDE's
     * Problems panel both reach this method, so a repair that works in CI is
     * the repair the panel applies. Answers whether the file changed; the
     * caller runs the pass again.
     */
    applyFix(finding) {
        if (!finding || !finding.fix || !finding.file)
            return false;

        const path  = File.Join(this.host.project, finding.file);
        const form  = File.LoadJson(path);
        const label = nodeNamed(form.children, finding.fix.label);

        if (!label) return false;

        label.properties = label.properties || {};
        if (label.properties.For) return false;
        label.properties.For = finding.fix.field;

        File.SaveJson(path, form);
        return true;
    }

    /* --- the manifest -------------------------------------------------------- */

    /*
     * `sources` is a **whitelist** once it is there, which is the half nobody
     * expects: a project with no `sources` loads every `.js` under it, and one
     * with a `sources` loads exactly those -- plus whatever a relative `import`
     * reaches, which is a load the list was never asked about. So adding a file
     * and forgetting the manifest is a file that never loads, and what says so
     * is a `ReferenceError` in whichever other file called it.
     *
     * The keys are `ProjectFile`'s own -- it is a `Record`, so what a
     * manifest may hold is a list this class does not have to keep.
     */
    manifest(found) {
        const rel  = !File.Exists(File.Join(this.host.project, "project.btp")) &&
                     File.Exists(File.Join(this.host.project, "project.json"))
                         ? "project.json" : "project.btp";
        const path = File.Join(this.host.project, rel);

        let cfg;
        try {
            cfg = File.LoadJson(path);
        } catch (e) {
            found.push({ kind: "Error", file: rel, line: 0, text: e.message });
            return;
        }

        /* How loudly the accessibility rows speak: the manifest's one word for
         * all of them, read here because this is where the manifest is read. */
        this.a11y = Accessibility.level(cfg);

        const known = new ProjectFile().PropertyNames().map((n) => n.toLowerCase());
        for (const key in cfg) {
            if (known.includes(key.toLowerCase())) continue;
            found.push({
                kind: "Warning", file: rel, line: 0,
                text: `"${key}" is not something a project.btp says: nothing reads it`,
            });
        }

        if (!Array.isArray(cfg.sources)) return;     /* none is "load everything" */

        /*
         * A `sources` list is what the *project* loads, and an explicit
         * `import` is a load too: `import "./SheetParts.js"` reads a module the
         * list does not name. The list is still a whitelist for everything
         * else, which is the mistake this warning exists to catch.
         */
        const imported = this.imported();
        const listed   = cfg.sources.map((s) => String(s));

        for (const file of this.host.classes.files) {
            if (!File.IsExtension(file, "js")) continue;
            if (listed.includes(file)) continue;
            if (imported.has(file)) continue;
            /* `bintana test`'s, which a run never loads on purpose. */
            if (isTestFile(file)) continue;

            found.push({
                kind: "Warning", file, line: 0,
                text: `sources does not list this file, so it is never loaded`,
            });
        }

        for (const named of listed) {
            if (File.Exists(File.Join(this.host.project, named))) continue;
            found.push({
                kind: "Error", file: rel, line: 0,
                text: `sources names ${named}, which is not there`,
            });
        }
    }

    /*
     * The project's own files that a relative `import` loads, in the spelling
     * `sources` uses. A bare specifier names a library, and a path that leaves
     * the project is not one of its files; both are left alone. The binding
     * forms come from the runtime's parser -- `Application.Symbols` -- because
     * `import` has more than one spelling; the side-effect form
     * (`import "./x.js"`) has no binding for the parser to report, so it is the
     * one shape read from the raw text, where the path is a string on purpose.
     */
    imported() {
        const out = new Set();
        if (!this.texts) return out;

        const add = (file, from) => {
            if (!from || !from.startsWith(".")) return;

            const target = File.Relative(
                File.Absolute(File.Join(this.host.project,
                                        File.Directory(file), from)),
                this.host.project).replace(/\\/g, "/");

            if (target && target !== ".." && !target.startsWith("../"))
                out.add(target);
        };

        for (const [file, text] of this.texts) {
            /* `import "./x.js"` binds nothing, so the parser has no symbol to
             * report; it is still a load. */
            for (const m of SIDE_EFFECT_IMPORT.Matches(text))
                add(file, m.Group(1));

            let syms;
            try { syms = Application.Symbols(text); } catch (e) { continue; }

            for (const s of syms)
                if (s.Kind === "Import") add(file, s.From);
        }
        return out;
    }

    /* --- one .form ----------------------------------------------------------- */

    /*
     * The shape of a `.form`, against the loader's rules
     * (`runtime/src/bta_form.c`): object at the root, an object for
     * `properties`, lists for `children`, `menus` and `actions`, a `type` on
     * every control, and a depth a person could still read. `null` and an
     * absent key are the same "not written", which is how the serialiser
     * leaves a form with no menus.
     *
     * **Everything is reported, and nothing throws.** A row is file-level
     * (`line: 0`) because JSON in this language has no line to point at; the
     * message names the path through the tree instead. `true` means the
     * loader would build what is there, and the callers below may walk it.
     */
    formShape(root, rel, found) {
        const MAX_DEPTH = 128;        /* BTA_FORM_MAX_DEPTH in bta_form.c */
        const bad = (text) => found.push({ kind: "Error", file: rel, line: 0, text });
        const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
        const ident = (v) => typeof v === "string" &&
                             /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(v);
        /* GLib's action name, not a JavaScript identifier: `form.<name>` is
         * what a menu item or a command becomes, and `_` is refused there
         * while `-` and `.` are allowed. */
        const actionName = (v) => typeof v === "string" &&
                                  /^[A-Za-z0-9.-]+$/.test(v);
        let ok = true;

        if (!object(root)) {
            bad(`a .form is a JSON object`);
            return false;
        }

        const properties = (v, where) => {
            if (v === undefined || v === null) return true;
            if (!object(v)) {
                bad(`${where ? where + ": " : ""}"properties" is not an object`);
                ok = false;
                return false;
            }
            return true;
        };

        const list = (v, where, key) => {
            if (v === undefined || v === null) return true;
            if (!Array.isArray(v)) {
                bad(`${where ? where + ": " : ""}"${key}" is not a list`);
                ok = false;
                return false;
            }
            return true;
        };

        /* A path is useful for the first few levels and unreadable at five
         * hundred: a deep error says the depth instead of spelling out every
         * index above it. */
        const beneath = (where, i, depth) =>
            depth > 4 ? `a control at depth ${depth}`
                      : `${where ? where + "." : ""}children[${i}]`;

        const control = (node, where, depth) => {
            if (depth > MAX_DEPTH) {
                bad(`the tree nests deeper than ${MAX_DEPTH}`);
                ok = false;
                return;
            }
            if (!object(node)) {
                bad(`${where} is not a control`);
                ok = false;
                return;
            }
            if (typeof node.type !== "string" || !node.type) {
                bad(`${where} has no "type"`);
                ok = false;
                return;
            }
            if (node.name !== undefined && node.name !== null && !ident(node.name)) {
                bad(`${where} is called ` +
                    `${JSON.stringify(node.name)}, which is not a name`);
                ok = false;
            }
            properties(node.properties, where);

            /* The menu a control shows from its own press is a property, not a
             * block of the form, and `Names.tableOf` walks it: a `null` in it
             * threw there even though the form itself was otherwise fine. */
            const popup = object(node.properties) ? node.properties.Menu : undefined;
            if (popup !== undefined && popup !== null) {
                if (Array.isArray(popup)) {
                    for (let i = 0; i < popup.length; i++)
                        menu(popup[i], `${where}.properties.Menu[${i}]`, 2);
                } else if (object(popup)) {
                    menu(popup, `${where}.properties.Menu`, 2);
                } else {
                    bad(`${where}: "Menu" is not a menu`);
                    ok = false;
                }
            }

            if (list(node.children, where, "children"))
                for (let i = 0; i < (node.children || []).length; i++)
                    control(node.children[i], beneath(where, i, depth + 1), depth + 1);
        };

        const menu = (node, where, depth) => {
            if (depth > MAX_DEPTH) {
                bad(`the tree nests deeper than ${MAX_DEPTH}`);
                ok = false;
                return;
            }
            if (!object(node)) {
                bad(`${where} is not a menu item`);
                ok = false;
                return;
            }
            if (node.name !== undefined && node.name !== null &&
                !actionName(node.name)) {
                bad(`${where} is called ${JSON.stringify(node.name)}, ` +
                    `which is not an action name`);
                ok = false;
            }
            if (list(node.children, where, "children"))
                for (let i = 0; i < (node.children || []).length; i++)
                    menu(node.children[i], beneath(where, i, depth + 1), depth + 1);
        };

        properties(root.properties, "");

        if (list(root.children, "", "children"))
            for (let i = 0; i < (root.children || []).length; i++)
                control(root.children[i], `children[${i}]`, 1);

        if (list(root.menus, "", "menus"))
            for (let i = 0; i < (root.menus || []).length; i++)
                menu(root.menus[i], `menus[${i}]`, 1);

        const command = (node, where, depth) => {
            if (depth > MAX_DEPTH) {
                bad(`the tree nests deeper than ${MAX_DEPTH}`);
                ok = false;
                return;
            }
            if (!object(node)) {
                bad(`${where} is not a command`);
                ok = false;
                return;
            }
            if (typeof node.name !== "string" || !node.name) {
                bad(`${where} has no "name"`);
                ok = false;
            } else if (!actionName(node.name)) {
                bad(`${where} is called ${JSON.stringify(node.name)}, ` +
                    `which is not an action name`);
                ok = false;
            }
            if (list(node.children, where, "children"))
                for (let i = 0; i < (node.children || []).length; i++)
                    command(node.children[i], `${where}.children[${i}]`, depth + 1);
        };

        if (list(root.actions, "", "actions"))
            for (let i = 0; i < (root.actions || []).length; i++)
                command(root.actions[i], `actions[${i}]`, 1);

        return ok;
    }

    /*
     * Three things a form file can say that the loader takes without a word.
     *
     * The collision one is the subtlest and the measurement is worth keeping:
     * a control named `Close` **wins** -- `this.Close` is the label, and the
     * method is what is lost -- while a control named `Actions` **loses**, since
     * that one is a getter with no setter and the assignment goes nowhere. The
     * same mistake resolves two different ways depending on what it lands on,
     * and neither way says anything. So the test is `Widget.Member` against the
     * class, which answers for both -- and is the `in` this used to run on a
     * bare `Form` made to ask.
     */
    form(rel, found) {
        let root;
        try {
            root = File.LoadJson(File.Join(this.host.project, rel));
        } catch (e) {
            found.push({ kind: "Error", file: rel, line: 0, text: e.message });
            return;
        }

        /*
         * A file a person edited is a claim until the shape is proven. The
         * walkers below assume an object root, lists of object nodes, and a
         * `type` on each; a truncated save (`null`), a `children` left as an
         * object, or a `null` in a list used to make this pass **throw** -- the
         * tool printed a stack trace, the IDE's panel showed nothing, and the
         * one file the person needed to hear about was the one that stopped the
         * pass. `formShape` reports the same rules the loader enforces, so the
         * two refuse the same file.
         */
        if (!this.formShape(root, rel, found))
            return;

        /*
         * The names come from `Names`, which walks all three blocks a
         * `.form` binds by name -- `children`, `menus` and `actions`. This
         * class had a walk of its own that read `children` alone, so a menu
         * item called `Close` was a collision nothing looked for.
         */
        const seen = {};
        for (const node of this.host.names.tableOf(root)) {
            if (seen[node.name])
                found.push({
                    kind: "Error", file: rel, line: 0,
                    text: `two controls are called ${node.name}: only the ` +
                          `last one is built`,
                });
            seen[node.name] = true;

            if (Widget.Member("Form", node.name) !== "") {
                /*
                 * Two different futures, and the reader does different things
                 * about them -- so they are two different rows. A **read-only**
                 * member (`Actions`, `Menus`, `Controls`, `DefaultButton`,
                 * `CancelButton`) or a method (`Close`, `Show`) makes the
                 * bind fail, and all three loaders refuse the form now: the
                 * program will not start. A settable property is shadowed,
                 * the form runs, and this is the only thing that will ever
                 * say so.
                 */
                const refused = this.refusedByForm(node.name);
                const method  = Widget.Member("Form", node.name) === "Method";

                found.push({
                    kind: refused ? "Error" : "Warning", file: rel, line: 0,
                    text: refused
                        ? `${node.name} is also a ${method ? "method" : "read-only member"} ` +
                          `of Form: the form will not load`
                        : `${node.name} is also a member of Form: one of ` +
                          `the two is unreachable under that name`,
                });
            }
        }

        /*
         * The properties, which is a walk of `children` and only of `children`:
         * what a menu item or a command declares is `text`, `icon`, `shortcut`
         * -- keys of the file, in lower case, and not properties of a class.
         */
        const walk = (nodes) => {
            for (const node of nodes || []) {
                if (node.properties && node.type)
                    for (const key in node.properties)
                        if (this.hasMember(node.type, key) === false)
                            found.push({
                                kind: "Warning", file: rel, line: 0,
                                text: `${node.type} has no ${key}: the value is ` +
                                      `read and does nothing (${node.name || "unnamed"})`,
                            });

                walk(node.children);
            }
        };
        walk(root.children);

        /* What a screen reader cannot name, at the severity the project chose --
         * and nothing at all when it chose `off`. */
        const kind = Accessibility.kind(this.a11y);
        if (kind)
            for (const entry of Accessibility.entries(root)) {
                const row = { kind, file: rel, line: 0, text: entry.text };
                if (entry.fix) row.fix = entry.fix;
                found.push(row);
            }
    }

    /*
     * Whether a class of that type has the member -- and **`null` when nothing
     * here can say**, which is a component of the project: its class belongs to
     * a process this one is not, so the node is passed over rather than guessed
     * at. Every runtime class answers by name, `MenuItem` and `Action`
     * included.
     */
    hasMember(type, key) {
        /*
         * **A class this process can answer for, and nothing guessed for one it
         * cannot.** `Widget.Member` reaches every runtime class, including the
         * `MenuItem` and `Action` that have no global constructor, and throws
         * for a component of the project -- whose class belongs to another
         * process. A throw there is *nothing here can say*, which is `null`,
         * and not a missing property.
         */
        try {
            return Widget.Member(type, key) !== "";
        } catch (e) {
            return null;
        }
    }

    /* --- one .js ------------------------------------------------------------- */

    /*
     * Two questions about a source file, and only one of them needs a `.form`.
     *
     * **The syntax check is the one that used to be missing, and it was missing
     * for the reason the second one is skipped.** `Live` checks the file on
     * screen and the save-time check in `TabSet` checks the tab in front of
     * you, so a module -- a `.js` with no `.form` beside it, which is most of
     * them -- was read by nobody at any point. The answer came from the run
     * instead, as a `ReferenceError` in whichever *other* file called it, and
     * `Application.CheckSource` was sitting right there with a line and a column
     * in it. There is nothing a `.form` can add to that question and the check
     * asks none, which is why it does not have one.
     *
     * The cost is a compile per file, and it was measured rather than guessed:
     * 610 us a file over this repository's own 63 `.js` and 1.07 MB of ide/,
     * 39 ms for the whole set, three rounds agreeing to within 4%. It is
     * proportional to the bytes and not to the number of files, so a project of
     * four hundred small modules costs less than one large form. It runs once,
     * when a project opens, and again on demand from Project -> Check.
     */
    code(rel, found) {
        let text = this.texts ? this.texts.get(rel) : undefined;

        if (text === undefined) {
            try {
                text = File.Load(File.Join(this.host.project, rel));
            } catch (e) {
                return;                   /* a half-written file is not this pass's */
            }
        }

        const bad = Application.CheckSource(text);
        if (bad)
            found.push({ kind: "Error", file: rel, line: bad.Line, text: bad.Message });

        /* The names the language has taken, which asks no `.form` and so runs on
         * a module as well as on a form's own class. `Names` owns it and
         * `Live` runs the same one over the file on screen. */
        for (const problem of this.host.names.curated(text, rel, -1))
            found.push(problem);
        for (const problem of this.host.names.ambiguous(text, rel, -1))
            found.push(problem);
        for (const problem of this.host.names.unresolved(text, rel, -1))
            found.push(problem);
        for (const problem of this.host.names.shadowing(text, rel, -1))
            found.push(problem);

        const form = this.host.classes.formOf(rel);
        if (!form) return;

        let root;
        try {
            root = File.LoadJson(File.Join(this.host.project, form));
        } catch (e) {
            return;                       /* the .form's own problem, `form()` says it */
        }

        /* The shape `form()` already judged; its rows say what is wrong, so
         * this pass only needs the answer. Without it a `children` left as an
         * object made every `.js` beside it report a second, invented problem
         * ("value is not iterable") on top of the real one. */
        if (!this.formShape(root, form, [])) return;

        const controls = this.host.names.tableOf(root);
        for (const problem of this.host.names.check(text, controls, rel, -1))
            found.push(problem);
    }
}

/* The control with that name, at any depth: how `applyFix` finds the caption
 * a finding names. A plain walk and not `Names.tableOf`, which is about the
 * names a form binds and carries the type with each one. */
function nodeNamed(nodes, name) {
    if (!Array.isArray(nodes)) return null;
    for (const node of nodes) {
        if (!node || typeof node !== "object") continue;
        if (node.name === name) return node;
        const deeper = nodeNamed(node.children, name);
        if (deeper) return deeper;
    }
    return null;
}

/* `bintana test` reads this folder; a normal run never loads it, and the
 * missing-source warning would be wrong about every file in it. A project-relative
 * path, as every finding is. */
function isTestFile(file) {
    return String(file).split("/")[0] === "tests";
}
