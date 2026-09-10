/*
 * Http, against a public JSON API.
 *
 * A console project (`"main"`, no window): the blocking spelling is the whole
 * of it -- a tool that asks, looks at what happened, and goes on.
 *
 *   ./build/bintana examples/http
 *
 * Needs the network, and says so out loud when it has none: jsonplaceholder is
 * a free test API, so there is nothing to sign up for and nothing to keep secret.
 * Credentials, when a real API wants them, come from code or Settings -- never
 * from a `.form`, where they would land in version control.
 */
"use strict";

function Main() {
    const api = Http.Client({
        BaseUrl: "https://jsonplaceholder.typicode.com",
        Headers: { Accept: "application/json" },
        Timeout: 15000,
    });

    let posts;
    try {
        posts = api.GetWait("/posts", { Query: { _limit: "3" } });
    } catch (e) {
        print(`cannot reach the API: ${e.message}`);
        Application.Quit(1);
        return;
    }
    if (posts.Status !== 200) {
        print(`the API answered ${posts.Status} ${posts.Reason}`);
        Application.Quit(1);
        return;
    }

    const list = JSON.parse(posts.Body.ToText());

    for (const p of list)
        print(`#${p.id} ${p.title}`);

    // One post, read whole, through the shared shorthand.
    const one = Http.GetWait("https://jsonplaceholder.typicode.com/posts/1",
                             { Timeout: 15000 });
    const post = JSON.parse(one.Body.ToText());

    print(`---\n#${post.id} by user ${post.userId}\n${post.body}`);

    // One post, created: an object becomes canonical JSON with application/json.
    const created = api.PostWait("/posts",
                                 { title: "hello", body: "from bintana", userId: 1 });

    print(`created: ${created.Status} ${created.Body.ToText().slice(0, 60)}...`);
    Application.Quit(0);
}
