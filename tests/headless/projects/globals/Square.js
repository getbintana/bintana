"use strict";

/* A worker: the core runs it on a thread of its own, as the graphical host
 * does, with the same `Application.Arguments` the main thread has. */
class Square extends Task {
    Run(n) {
        return { square: n * n, args: Application.Arguments.join("|") };
    }
}
