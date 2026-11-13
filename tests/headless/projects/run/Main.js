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

    /* The library questions, over the search `uses` resolved with: the
     * project's own `lib/` first when no project is named, the same with an
     * explicit `undefined`, and every library a project could name. */
    const own = File.Join(Application.Directory, "lib", "greeting");
    print(`LibraryPath: ${Application.LibraryPath("greeting") === own} ` +
          `${Application.LibraryPath("greeting", undefined) === own}`);
    const all = Application.Libraries();
    print(`Libraries: ${all.includes("greeting")} ${all.includes("report")}`);
}
