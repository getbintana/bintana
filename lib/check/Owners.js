/*
 * Which files export a top-level name.
 *
 * The runtime refuses to start a program that uses a name two modules export
 * and did not import: *'Parser' is exported by Csv.js and Ini.js: choose one
 * with import*. The check says the same thing while the file is being written,
 * and it needs the same map -- name -> the files that own it.
 *
 * **The rule is the runtime's, not a guess**: only a declaration a module
 * exports, and not an imported name exported again, makes a file an owner. That
 * is why `From` and the imported set are read here exactly as `Completion`
 * reads them. A component of the project is never loaded by this process, so
 * `Application.Symbols` is the one reader both can use.
 */
"use strict";

/* `Namespace("A.B")`: the call that puts `A` on the global object at run time.
 * Read from the raw text, because the name is a string on purpose -- the same
 * reason `Check`'s side-effect import is. A match inside a comment only makes
 * a name known, which costs a missed finding and never a false one. */
const NAMESPACE_CALL = new Regex(
    "\\bNamespace[ \\t]*\\([ \\t]*[\"']([A-Za-z_$][\\w$]*)", { Multiline: true });

export class Owners {

    /**
     * What one file puts in the scope every file shares, out of its symbols:
     * a script, everything it declares at its top level; a module, only what
     * it exports -- the rest is its own (`kept`). `classes` are the ones whose
     * declaration is reached by that name, `own` the exports that are this
     * file's declaration and not a re-export. **The one reading of that
     * rule**: the IDE's completion and the check's unresolved names both ask
     * here, so the two cannot disagree about which names a file publishes.
     * @param {object[]} symbols what `Application.Symbols` answered for the file
     * @returns {{ classes: string[], tops: string[], own: string[], kept: string[], module: boolean }}
     */
    static published(symbols) {
        /* Contained means a function that **starts on an earlier line**: the
         * parser gives lines and not columns, and `const D = (t) => new
         * Decimal(t)` declares `D` on the line its arrow opens -- with `<=` the
         * name was a local and every use of it in another file a false
         * finding. The cost is the other way round: a one-line function's own
         * `let` counts as published, which hides a misspelling rather than
         * inventing one. */
        const scopes  = symbols.filter((s) => s.Kind === "Scope");
        const inside  = (line) => scopes.some((sc) => sc.Line < line && line <= sc.End);
        const isModule = symbols.some((s) => s.Kind === "Export" || s.Kind === "Import");
        const classes = [];
        const tops    = [];
        const own     = [];
        const kept    = [];
        const add     = (list, name) => { if (name && !list.includes(name)) list.push(name); };

        /* The file's top level: a variable no function contains, every
         * top-level function, and a class no function contains. */
        const declared = [];
        for (const s of symbols) {
            if (s.Kind === "Variable" && !inside(s.Line)) add(declared, s.Name);
            else if (s.Kind === "Function") add(declared, s.Name);
        }

        if (!isModule) {
            for (const s of symbols)
                if (s.Kind === "Class") classes.push(s.Name);
            for (const name of declared) add(tops, name);
            return { classes, tops, own, kept, module: false };
        }

        const exports  = symbols.filter((s) => s.Kind === "Export" &&
                                               s.Name !== "default" && s.Name !== "*");
        const imported = new Set(symbols.filter((s) => s.Kind === "Import").map((s) => s.Name));
        const handed   = new Set();
        for (const e of exports) {
            add(tops, e.Name);
            if (!e.From) handed.add(e.Parent);
            if (!e.From && !imported.has(e.Parent)) add(own, e.Name);
            if (!e.From && e.Parent === e.Name &&
                symbols.some((s) => s.Kind === "Class" && s.Name === e.Name))
                classes.push(e.Name);
        }
        for (const s of symbols)
            if (s.Kind === "Class" && !inside(s.Line)) add(declared, s.Name);
        for (const name of declared)
            if (!handed.has(name) && !imported.has(name)) add(kept, name);
        return { classes, tops, own, kept, module: true };
    }

    /** The top-level names a file's `Namespace("A.B")` calls create: `A`.
     * @param {string} text
     * @returns {string[]} */
    static namespaces(text) {
        const out = [];
        for (const m of NAMESPACE_CALL.Matches(text))
            if (!out.includes(m.Group(1))) out.push(m.Group(1));
        return out;
    }

    /**
     * What the whole program answers by name, over every source it is made of
     * -- its own files and its libraries': `known`, the names some file
     * publishes or a `Namespace` call creates, and `kept`, the names a module
     * declares and does not export, each with the files that keep it. What
     * `Names.unresolved` reads a file's free names against.
     * @param {Iterable<{path: string, text: string}>} sources
     * @returns {{ known: Set<string>, kept: Map<string, string[]> }}
     */
    static answers(sources) {
        const known = new Set();
        const kept  = new Map();

        for (const { path, text } of sources) {
            let symbols;
            try { symbols = Application.Symbols(text); }
            catch (e) { continue; }

            const p = Owners.published(symbols);
            for (const n of p.tops)    known.add(n);
            for (const n of p.classes) known.add(n);
            for (const n of Owners.namespaces(text)) known.add(n);
            for (const n of p.kept) {
                if (!kept.has(n)) kept.set(n, []);
                kept.get(n).push(path);
            }
        }
        return { known, kept };
    }

    /*
     * `sources` is `[{ path, text }, …]`, as `ProjectFiles.sources()` answers.
     * A file that does not parse contributes nothing, which is the syntax
     * check's finding and not a smaller map to report twice.
     */
    static of(sources) {
        const owners = new Map();

        for (const { path, text } of sources) {
            let symbols;
            try { symbols = Application.Symbols(text); }
            catch (e) { continue; }

            const exports = symbols.filter((s) => s.Kind === "Export" &&
                                                   s.Name !== "default" &&
                                                   s.Name !== "*");
            const isModule = symbols.some((s) => s.Kind === "Export" ||
                                                   s.Kind === "Import");
            if (!isModule) continue;

            const imported = new Set(symbols
                .filter((s) => s.Kind === "Import")
                .map((s) => s.Name));
            const own = new Set();

            for (const e of exports) {
                /* `export { x } from "…"` and an imported name exported again
                 * are not this file's declaration: one binding handed out twice
                 * is one answer, and the runtime's own rule. */
                if (e.From || imported.has(e.Parent) || own.has(e.Name)) continue;
                own.add(e.Name);

                if (!owners.has(e.Name)) owners.set(e.Name, []);
                const list = owners.get(e.Name);
                if (!list.includes(path)) list.push(path);
            }
        }
        return owners;
    }
}
