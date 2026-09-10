/*
 * Http.Server as a static file server, over its own directory.
 *
 * Ten lines of handler: routing, `Bytes` straight from disk to socket, and
 * statuses. `/` answers an index built from `Directory.Files`; anything else
 * is a file or a `404`, with the content type the desktop already knows
 * (`File.Info`'s `Type`, which is a value to test rather than prose to
 * show). There is deliberately no `".."` refusal: `req.Path` arrives with
 * dot-segments already normalized (`/a/../../x` is `/x` before the handler
 * runs, encoded or not), so `File.Join` under the root cannot escape it --
 * measured, and the property this example stands on.
 *
 * `srv` lives at module scope on purpose: a server lives as long as its
 * object, and dropping it disconnects (a port is not left held past whoever
 * held it). A `const` inside `Main` would die with the return, before the
 * first request ever arrived.
 *
 * A console project that never returns: a listening server counts like a
 * watch, so `main` stays for its requests instead of exiting before the
 * first one. Runs until killed (`Ctrl-C`).
 *
 * Run it with `./build/bintana examples/serve`, then open
 * http://127.0.0.1:8080/ somewhere that is not this machine's business.
 */
"use strict";

const root = Application.Directory;
const srv = Http.Server({ Port: 8080 });
let served = 0;

function Main() {
    srv.Request = (req) => {
        if (req.Method !== "GET") {
            req.Answer(405, "read-only");
            return;
        }
        if (req.Path === "/") {
            let out = "<html><body><ul>";
            for (const f of Directory.Files(root, { Recursive: true })) {
                const rel = f.slice(root.length + 1);
                out += `<li><a href="/${rel}">${rel}</a></li>`;
            }
            req.Answer(200, out + "</ul></body></html>", { ContentType: "text/html" });
            return;
        }
        const path = File.Join(root, req.Path.slice(1));

        if (!File.Exists(path) || File.IsDir(path)) {
            req.Answer(404, "nope");
            return;
        }
        served++;
        print(`#${served} ${req.Remote} GET ${req.Path}`);
        req.Answer(200, File.LoadBytes(path), { ContentType: File.Info(path).Type });
    };
    srv.Start();
    print(`serving ${root} at ${srv.Url}`);
}
