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

export class Owners {

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
