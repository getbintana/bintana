"use strict";

/*
 * What a console `main` gets: the language, the core globals, the project's
 * libraries, every word after the project, and no window.
 */
function Main() {
    print(Greeting.Of("console"));
    print(`${Application.Name} ${Application.Version}`);
    print(Application.Arguments.join("|"));
    print(JSON.stringify({ ok: true }));
}
