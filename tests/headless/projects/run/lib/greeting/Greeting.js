"use strict";

/* A library needs no manifest: a directory of classes is the whole of it. The
 * fixture is what proves `uses` resolves and that a library's sources load
 * before the project's -- the same way in both hosts. */
export class Greeting {
    static Of(name) {
        return `hello, ${name}`;
    }
}
