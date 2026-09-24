/*
 * The packaging step, from a shell or from a build:
 *
 *   ./build/bintana tools/pack <project> <out> [--finish-args <a,b,c>]
 *   tools/pack.sh <project> <out> [--finish-args <a,b,c>]
 *
 * It writes the files a package is built from -- the metainfo, the `.desktop`,
 * the icon and the Flatpak manifest -- into `<out>`, which is then a build
 * context: `flatpak-builder <out>/<id>.json` builds it.  What each file has to
 * say is `lib/package`'s, and so are the refusals; this is the command line.
 *
 * **`--finish-args` is how an application asks for more than a window.**  The
 * default is the four permissions an ordinary application needs, and a program
 * that opens the user's files adds `--filesystem=home` (or a narrower one) --
 * without it its file dialog browses a sandbox that has nothing in it.
 *
 * A console project, so it needs no display and can run in a build.
 */
"use strict";

function Main() {
    const args = Application.Arguments;

    let project = "";
    let out     = "";
    let finish  = null;

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--finish-args") {
            finish = (args[++i] || "").split(",").filter((a) => a !== "");
        } else if (!project) {
            project = args[i];
        } else if (!out) {
            out = args[i];
        } else {
            project = "";
            break;
        }
    }

    if (!project || !out) {
        print("usage: pack <project> <out> [--finish-args <a,b,c>]");
        Application.Quit(2);
        return;
    }

    let written;
    try {
        written = Package.Write(project, out, finish ? { FinishArgs: finish } : {});
    } catch (e) {
        print(`pack: ${e.message}`);
        Application.Quit(1);
        return;
    }

    print(`id:       ${written.Id}`);
    print(`command:  ${written.Command}`);
    print(`manifest: ${written.Manifest}`);
    print(`metainfo: ${written.Metainfo}`);
    print(`desktop:  ${written.Desktop}`);
    if (written.Icon)
        print(`icon:     ${written.Icon}`);
    Application.Quit(0);
}
