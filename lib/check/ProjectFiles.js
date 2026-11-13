/*
 * The files a project is made of, and the pair a form travels in.
 *
 * This is the half of the IDE's `Classes` that the check needs, with no project
 * tree, no components and no `ide`: a root path, a walk that skips hidden names,
 * and the sibling lookup that says which `.form` belongs to a `.js`.
 *
 * Paths are project-relative and use `/`, the spelling the `.form` loader, the
 * runtime's messages and the findings all use. Nothing here reads or parses a
 * file; `sources()` is the one door that does, and a caller that wants every
 * source reads it once.
 */
"use strict";

/* The file next to this one with another extension, or the path unchanged when
 * it already has it. A form is two files that travel together, so this is the
 * only pairing rule there is. */
function sibling(file, ext) {
    return File.Join(File.Directory(file), `${File.BaseName(file)}.${ext}`);
}

export class ProjectFiles {

    /** @param {string} root the project directory, absolute or relative */
    constructor(root) {
        this.root = String(root || "");
        this.files = [];                 /* relative, `/`-separated */
    }

    /* Walks the project and keeps every file, hidden entries aside. A folder is
     * part of the project; only a leading dot is the repository's own, and a
     * folder with its own `project.btp` is a project of its own -- the
     * `privileged` helper is one -- not a folder of this one. */
    scan() {
        this.files = [];
        if (!this.root) return this.files;
        this.#walk("");
        return this.files;
    }

    #walk(folder) {
        const here = folder ? File.Join(this.root, folder) : this.root;

        for (const name of Directory.List(here)) {
            if (name.startsWith(".")) continue;

            const rel = folder ? `${folder}/${name}` : name;

            if (File.IsDir(File.Join(this.root, rel))) {
                /* A directory with its own manifest is a project of its own --
                 * the `privileged` helper is one -- and not a folder of this
                 * project's sources. */
                if (File.Exists(File.Join(this.root, rel, "project.btp")))
                    continue;
                this.#walk(rel);
            } else {
                this.files.push(rel);
            }
        }
    }

    /* The `.form` a `.js` stands for, or null. The `.form` itself answers for
     * itself, the way `Classes.formOf` does. */
    formOf(file) {
        if (!file || !this.files.includes(file)) return null;
        if (!File.IsExtension(file, "js") && !File.IsExtension(file, "form"))
            return null;

        const form = sibling(file, "form");
        return this.files.includes(form) ? form : null;
    }

    /* Every `.js` of the project, as `{ path, text }`, in the order the walk
     * found them. One read each: ownership and the syntax check share it. */
    sources() {
        const out = [];

        for (const file of this.files)
            if (File.IsExtension(file, "js")) {
                let text = "";
                try { text = File.Load(File.Join(this.root, file)); }
                catch (e) { continue; }     /* a half-written file is not this pass's */
                out.push({ path: file, text });
            }
        return out;
    }
}
