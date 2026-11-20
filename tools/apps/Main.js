/*
 * tools/apps: the applications a user installed for themselves, from a
 * terminal.
 *
 *   bintana apps                  the entries the IDE installed
 *   bintana apps list             the same
 *   bintana apps files <id>       what one of them installed, one path per line
 *   bintana apps remove <id>...   take them out of the menu
 *   bintana apps --json           every answer as one JSON object per line
 *
 * What is installed belongs to the user, not to a project: this runs in the
 * core, over `Desktop.Entries` (or `Desktop.Shortcut`), and needs no display
 * and no project open. `lib/apps` is the one place that knows which entries are
 * Bintana's, so the IDE's dialog and this command answer the same thing about
 * the same folder -- and a removal here is the removal that dialog makes.
 *
 * **Nothing is removed that this did not list.** An id that is not one of the
 * applications the IDE installed is refused, because the folder also holds the
 * entries a packaged application exported and those are not ours to delete.
 */
"use strict";

function usage() {
    print("usage: bintana apps [list] [--json]");
    print("       bintana apps files <id>");
    print("       bintana apps remove <id>...");
}

function main() {
    const words = [];
    let   json  = false;

    for (const arg of Application.Arguments) {
        if (arg === "--json") {
            json = true;
        } else if (arg === "-h" || arg === "--help") {
            usage();
            Application.Quit(0);
            return;
        } else if (arg.charAt(0) === "-") {
            print(`apps: no such option ${arg}`);
            Application.Quit(2);
            return;
        } else {
            words.push(arg);
        }
    }

    let command = "list";
    if (words.length > 0 && ["list", "files", "remove"].includes(words[0]))
        command = words.shift();

    if (command === "files")  return files(words[0], json);
    if (command === "remove") return remove(words, json);

    list(json);
}

/* The columns are padded so a terminal shows a table; the ids are the key a
 * `files` or `remove` takes, so they are what a person copies. */
function list(json) {
    const entries = Apps.List();

    if (json) {
        for (const entry of entries)
            print(JSON.stringify({ Id: entry.Id, Name: entry.Name,
                                   Project: entry.Project,
                                   Files: Apps.Files(entry.Id) }));
    } else if (entries.length === 0) {
        print("No application installed from the IDE.");
    } else {
        let idWidth   = 0;
        let nameWidth = 0;

        for (const entry of entries) {
            idWidth   = Math.max(idWidth, entry.Id.length);
            nameWidth = Math.max(nameWidth, entry.Name.length);
        }

        for (const entry of entries)
            print(pad(entry.Id, idWidth) + "  " +
                  pad(entry.Name, nameWidth) + "  " + entry.Project);
    }

    Application.Quit(0);
}

function files(id, json) {
    if (!id) {
        usage();
        Application.Quit(2);
        return;
    }

    const entry = known(id);
    if (!entry) {
        Application.Quit(1);
        return;
    }

    const paths = Apps.Files(id);

    if (json) {
        print(JSON.stringify({ Id: id, Files: paths }));
    } else {
        for (const path of paths) print(path);
    }

    Application.Quit(0);
}

function remove(ids, json) {
    if (ids.length === 0) {
        usage();
        Application.Quit(2);
        return;
    }

    let failed = false;

    for (const id of ids) {
        if (!known(id)) {
            failed = true;
            continue;
        }

        try {
            Apps.Uninstall(id);
        } catch (e) {
            print(`apps: ${e.message}`);
            failed = true;
            continue;
        }

        if (json) print(JSON.stringify({ Id: id, Removed: true }));
        else      print(`removed ${id}`);
    }

    Application.Quit(failed ? 1 : 0);
}

/* The entry, or a sentence and `null`: the folder holds other programs' entries
 * too, and a removal that took one of them would be this command deleting
 * somebody else's application. */
function known(id) {
    for (const entry of Apps.List())
        if (entry.Id === id) return entry;

    print(`apps: no application installed as ${id}`);
    return null;
}

function pad(text, width) {
    let out = text;
    while (out.length < width) out += " ";
    return out;
}
