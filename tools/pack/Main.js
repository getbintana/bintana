/*
 * The packaging step, from a shell or from a build:
 *
 *   ./build/bintana tools/pack <project> <out>
 *   tools/pack.sh <project> <out>
 *
 * It writes the files a package is built from -- the metainfo, the `.desktop`,
 * the icon and the Flatpak manifest -- into `<out>`, which is then a build
 * context: `flatpak-builder <out>/<id>.json` builds it.  What each file has to
 * say is `lib/package`'s, and so are the refusals; this is the command line.
 *
 * A console project, so it needs no display and can run in a build.
 */
"use strict";

function Main() {
    const args = Application.Arguments;

    if (args.length !== 2) {
        print("usage: pack <project> <out>");
        Application.Quit(2);
        return;
    }

    let written;
    try {
        written = Package.Write(args[0], args[1]);
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
