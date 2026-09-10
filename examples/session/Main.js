/*
 * Http as a session, against httpbingo (https://httpbingo.org -- a free echo
 * of whatever a client does, so there is nothing to sign up for; httpbin.org
 * itself would do, except it sits on the Public Suffix List, where no client
 * that respects it -- browsers included -- may keep a cookie).
 *
 * A console project (`"main"`, no window), so the blocking spelling is the
 * whole of it: ask, look at what happened, go on. The narrative is a login --
 * the one thing cookies exist for:
 *
 *   1. nobody: the jar starts empty, and a wrong password is a 401 answer
 *   2. login: `Auth` answers the Basic challenge, `/cookies/set` answers 302
 *      (followed, like any redirect) and the jar keeps what fell out of it
 *   3. proving it: `/cookies` shows the session back, every verb echoes
 *   4. the contrast: a second client with no jar is still nobody
 *
 * Credentials live in code here because this is a demo against a test server.
 * A real program reads them from its own dialog or `Settings` -- never from a
 * `.form`, where they would land in version control.
 *
 * Run it with `./build/bintana examples/session`. It needs the network, and
 * says which call failed when it has none.
 */
"use strict";

function Main() {
    /* Named, because nameless clients get a 402 and no body from this one. */
    const api = Http.Client({ BaseUrl: "https://httpbingo.org",
                              Timeout: 20000, Cookies: true,
                              UserAgent: "Bintana/1.0" });

    const empty = api.GetWait("/cookies");
    print(`nobody: ${empty.Body.ToText().trim()}`);

    const wrong = Http.Client({ BaseUrl: "https://httpbingo.org", Timeout: 20000,
                                UserAgent: "Bintana/1.0",
                                Auth: { User: "u", Password: "no" } });
    print(`wrong password: ${wrong.GetWait("/basic-auth/u/p").Status}`);

    api.Auth = { User: "u", Password: "p" };
    const login = api.GetWait("/basic-auth/u/p");
    print(`login: ${login.Status} ${JSON.parse(login.Body.ToText()).authenticated}`);

    const set = api.GetWait("/cookies/set?session=abc");
    print(`set (via ${set.Status}): ${set.Body.ToText().trim()}`);
    print(`jar: ${api.GetWait("/cookies").Body.ToText().trim()}`);

    for (const [verb, fn] of [
        ["PUT", () => api.PutWait("/anything", { from: "session" })],
        ["DELETE", () => api.DeleteWait("/anything")],
    ]) {
        const r = fn();
        const echoed = JSON.parse(r.Body.ToText());
        print(`${verb}: ${r.Status} ${echoed.method} ${echoed.url}`);
    }

    const stranger = Http.Client({ BaseUrl: "https://httpbingo.org", Timeout: 20000,
                                      UserAgent: "Bintana/1.0" });
    print(`stranger: ${stranger.GetWait("/cookies").Body.ToText().trim()}`);
    Application.Quit(0);
}
