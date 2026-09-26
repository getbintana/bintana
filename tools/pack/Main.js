/*
 * The packaging step, from a shell or from a build:
 *
 *   ./build/bintana tools/pack <project> <out> [--finish-args <a,b,c>]
 *   tools/pack.sh <project> <out> [--finish-args <a,b,c>]
 *   tools/pack.sh --nsis <project> <out> [--exe <file>] [--prefix <tree>]
 *
 * The first form writes the files a Flatpak is built from -- the metainfo,
 * the `.desktop`, the icon and the manifest -- into `<out>`, which is then a
 * build context: `flatpak-builder <out>/<id>.json` builds it. The second
 * builds the Windows installer instead: the NSIS script out of the metainfo,
 * the payload staged from `--prefix` (or the tree this runtime runs from)
 * and the setup compiled with `makensis` -- on Windows, where both halves
 * run. What each file has to say is `lib/package`'s, and so are the refusals;
 * this is the command line.
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

    if (args[0] === "--nsis")
        return nsis(args.slice(1));

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
        print("       pack --nsis <project> <out> [--exe <file>] [--prefix <tree>]");
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

/*
 * The Windows installer, for a build: script, payload and compiler, out of
 * `lib/package/Nsis.js`. `<out>` is the build context the three share; the
 * setup executable goes to `--exe`, or beside the script under the name the
 * script itself defaults to. A refusal is `pack: ` and the sentence, like the
 * Flatpak half above.
 */
function nsis(args) {
    let project = "";
    let out     = "";
    let exe     = "";
    let prefix  = "";

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--exe")
            exe = args[++i] || "";
        else if (args[i] === "--prefix")
            prefix = args[++i] || "";
        else if (!project)
            project = args[i];
        else if (!out)
            out = args[i];
        else {
            project = "";
            break;
        }
    }

    if (!project || !out) {
        print("usage: pack --nsis <project> <out> [--exe <file>] [--prefix <tree>]");
        Application.Quit(2);
        return;
    }

    let ctx;
    try {
        ctx = Nsis.Script(project, out);
        Nsis.Stage(project, out, prefix ? { Prefix: prefix } : {});
        if (!exe)
            exe = File.Join(out, `${ctx.Command}-` +
                                 `${ctx.Version || "0.0"}-windows-x86_64.exe`);
        Nsis.Build(ctx.Script, File.Absolute(exe));
    } catch (e) {
        print(`pack: ${e.message}`);
        Application.Quit(1);
        return;
    }

    print(`id:      ${ctx.Id}`);
    print(`command: ${ctx.Command}`);
    print(`script:  ${ctx.Script}`);
    if (ctx.Icon)
        print(`icon:    ${ctx.Icon}`);
    if (ctx.Note)
        print(`note:    ${ctx.Note}`);
    print(`setup:   ${File.Absolute(exe)}`);
    Application.Quit(0);
}
