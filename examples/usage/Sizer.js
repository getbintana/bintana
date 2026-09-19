/*
 * One subtree's sizes, measured in a thread of its own.
 *
 * A `Task` subclass is the whole of the file: `Run` walks the roots it was
 * handed and answers their sizes, reporting each finished root on the way so
 * the window can count.  Everything it touches is read-only -- `Directory`
 * walks, `File.Info` sizes -- because a task observes and proposes while the
 * main thread disposes: the deleting, if there ever is any, happens there.
 *
 * Sizes are file bytes summed, not `du`: directory inodes themselves are not
 * counted, so the total is the sum of what the bars share rather than what
 * the disk driver sees.  Self-consistent, which is what a share needs.
 *
 * Unreadable corners are counted in `errors`, not fatal: one locked folder
 * must not sink a question about everywhere else, which is also
 * `Directory`'s own bargain.
 */
"use strict";

class Sizer extends Task {

    Run(msg) {
        let roots = 0;

        /* Reported on the way, so the window counts while it reads; answered
         * at the end, so the run knows when it is over.  The two never carry
         * the same root twice. */
        for (const root of msg.roots) {
            this.Report(this.sizeOne(root));
            roots++;

            /*
             * Asked to stop, between two roots rather than inside one.
             *
             * Not for the partial answer -- the window retires the whole run
             * by generation and drops it -- but so the thread **ends now**
             * instead of at the end of `KillAfter`.  A home directory is
             * minutes of work, and a Stop that took five seconds to be
             * honoured would leave N threads reading a disk nobody is
             * waiting on any more.
             */
            if (this.Stopping)
                return { roots, stopped: true };
        }
        return { roots };
    }

    /* One root, walked with an explicit stack and not recursion: a tree a
     * thousand levels deep is a walk, and a recursive one is a stack budget
     * question nobody needs to ask. */
    sizeOne(root) {
        let   size = 0, files = 0, dirs = 1, errors = 0;
        const stack = [root];

        while (stack.length) {
            const dir = stack.pop();
            let   subs, names;

            try {
                subs = Directory.Folders(dir);
                names = Directory.Files(dir);
            } catch (e) {
                errors++;
                continue;
            }
            for (const sub of subs) {
                dirs++;
                stack.push(sub);
            }
            for (const path of names) {
                const info = File.Info(path);

                if (!info) {
                    errors++;
                    continue;
                }
                size += info.Size;
                files++;
            }
        }

        const partial = { root, size, files, dirs, errors };

        return partial;
    }
}
