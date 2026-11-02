/*
 * One download, in a thread of its own.
 *
 * `Http.GetWait` blocks, which is what a worker is for: the window keeps
 * turning while this thread waits on the network. It is handed nothing about
 * cancellation, and needs nothing: a blocking call in a task is already linked
 * to the task's own signal, so `Stop()`, the `Timeout` guard and a shared
 * `Cancellable` raised on the main thread all reach it while it waits, and it
 * returns `cancelled` instead of a body.
 *
 * `File.SaveBytes` writes under a temporary name and renames into place, so a
 * download that is stopped leaves no half-written file behind.
 */
"use strict";

class Fetcher extends Task {

    Run(msg) {
        const r = Http.GetWait(msg.url);

        /* A 404 is an answer, not a failure, as far as `Http` is concerned;
         * as far as a download is concerned it is nothing to save. */
        if (r.Status >= 400)
            throw new Error(`${r.Status} ${r.Reason}`);

        File.SaveBytes(msg.path, r.Body);
        return { size: r.Body.Length };
    }
}
