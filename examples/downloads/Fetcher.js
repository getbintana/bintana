/*
 * One download, in a thread of its own.
 *
 * `Http.GetWait` blocks, which is what a worker is for: the window keeps
 * turning while this thread waits on the network. It is handed
 * `this.Cancellable`, the task's own signal, as its last argument: `Stop()`,
 * the `Timeout` guard and the shared `Cancellable` the window started it with
 * all raise that one, so each of them reaches the call while it waits, and it
 * throws `cancelled` instead of answering. A blocking call handed no token is
 * left alone while a stop is only asked, and ended by the Timeout and by
 * KillAfter all the same.
 *
 * `File.SaveBytes` writes under a temporary name and renames into place, so a
 * download that is stopped leaves no half-written file behind.
 */
"use strict";

class Fetcher extends Task {

    Run(msg) {
        /* HTTP/1.1, so a stop is seen at once rather than when the server
         * next sends something -- which over HTTP/2 can be never. */
        const r = Http.GetWait(msg.url, { Http1: true }, this.Cancellable);

        /* A 404 is an answer, not a failure, as far as `Http` is concerned;
         * as far as a download is concerned it is nothing to save. */
        if (r.Status >= 400)
            throw new Error(`${r.Status} ${r.Reason}`);

        File.SaveBytes(msg.path, r.Body);
        return { size: r.Body.Length };
    }
}
