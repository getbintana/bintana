/*
 * `Desktop.OpenUri` under a `main`, in both hosts. The graphical host runs a
 * `main` too and never initialises GTK there, so the address must be refused
 * with a sentence -- the console host's own -- and not handed to a launcher
 * with no display. A bad address is refused first, by name, the same way.
 */
"use strict";

function Main() {
    for (const uri of ["no scheme", "https://example.org/a?b=1&c=2"]) {
        try {
            Desktop.OpenUri(uri);
            print("opened " + uri);
        } catch (e) {
            print(e.message);
        }
    }
}
