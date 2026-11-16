/*
 * One download, in a thread of its own.
 *
 * `Http.GetWait` blocks, which is what a worker is for: the window keeps
 * turning while this thread waits on the network. It is handed
 * `this.Cancellable`, the task's own signal, as its last argument: `Stop()`
 * and the shared `Cancellable` the window started it with both raise that one,
 * so each of them reaches the call while it waits, and it throws `cancelled`
 * instead of answering.
 *
 * **`SaveTo` writes the answer to the file as it arrives**, one block in
 * memory whatever its size -- a 4 GB image costs 64 KB here, not 4 GB, and not
 * the 8 GB a `Body` copied into `Bytes` took at its peak. It goes through a
 * `.part` beside the file that is renamed at the end, so a download that is
 * stopped leaves nothing behind under any name.
 *
 * **`Progress` runs on this thread, inside the wait**, and `this.Report`
 * hands it to the window, where it arrives as the task's `Progress`. The
 * runtime calls it at most ten times a second and once at the end, so a large
 * file does not flood the window with a report per block.
 *
 * **With `SaveTo`, `Timeout` is the silence allowed, not the length**: a
 * download that keeps arriving is never cut, however long it takes, and one
 * that stops arriving for `stall` ms ends with `Kind: "Timeout"`. That ending
 * is answered as `{ stalled: true }` rather than thrown, so the window tells it
 * apart by a field and not by matching a message.
 */
"use strict";

class Fetcher extends Task {

    Run(msg) {
        let r;

        try {
            /* HTTP/1.1, so a stop is seen at once rather than when the server
             * next sends something -- which over HTTP/2 can be never. */
            r = Http.GetWait(msg.url, {
                Http1:    true,
                SaveTo:   msg.path,
                Timeout:  msg.stall,
                Progress: (received, total) => this.Report({ received, total }),
            }, this.Cancellable);
        } catch (e) {
            if (e.Kind === "Timeout")
                return { stalled: true };
            throw e;
        }

        /* A 404 is an answer, not a failure, as far as `Http` is concerned;
         * as far as a download is concerned it is nothing saved -- and no file
         * was made for it. */
        if (r.Status >= 400)
            throw new Error(`${r.Status} ${r.Reason}`);

        return { size: r.Length };
    }
}
