/*
 * One folder, compressed file by file in a thread of its own -- and every copy
 * read back before it is believed.
 *
 * The compressing is `Gzip.CompressFile`, which streams 64 KB at a time and writes
 * the result beside its destination under a temporary name, renaming it into place
 * only when the stream is whole: a failure part-way leaves *no* half-written `.gz`,
 * which is the property that makes it safe to do a thousand of these and look at
 * the ones that went wrong afterwards.
 *
 * **A backup nobody has read back is a hope.** So each copy is decompressed to a
 * scratch file and its SHA-256 compared with the original's -- `File.Hash` reads in
 * blocks, so verifying a video costs the buffer and not the video. It doubles the
 * work and is the only thing that turns "it wrote a file" into "that file holds
 * what was here". A copy that does not match is deleted, not kept, so the folder
 * never contains a backup that is known to be wrong.
 *
 * Everything in here is something a `Task` may do: reading and writing files is
 * allowed (`File.Save` is atomic, so two threads cannot tear one), and what is not
 * -- anything that calls back to the main loop -- is not used. `Gzip` is installed
 * in a worker for exactly this: compressing is CPU, and CPU on the main thread is
 * a window that does not move.
 */
"use strict";

class Packer extends Task {

    Run(msg) {
        const files = Directory.Files(msg.src, { Recursive: true });
        let   bytesIn = 0, bytesOut = 0;
        const bad = [];

        for (let i = 0; i < files.length; i++) {
            const path = files[i];
            const rel  = File.Relative(path, msg.src);
            const out  = File.Join(msg.dst, `${rel}.gz`);
            const size = File.Info(path).Size;
            let   ok   = false;
            let   packed = 0;

            try {
                Directory.Make(File.Directory(out));
                packed = Gzip.CompressFile(path, out);
                ok = this.readBack(path, out);
            } catch (e) {
                /* One unreadable file is a line in the report, not the end of
                 * the run -- the same bargain `Directory` itself makes. */
                ok = false;
            }

            if (ok) {
                bytesIn  += size;
                bytesOut += packed;
            } else {
                bad.push(rel);
                if (File.Exists(out))
                    File.Delete(out);
            }

            this.Report({ done: i + 1, total: files.length, rel, ok, size, packed });

            /* Between two files and not inside one, so the thread ends now and
             * not at the end of `KillAfter`; the window drops the answer anyway. */
            if (this.Stopping)
                return { files: i + 1, total: files.length, bytesIn, bytesOut, bad, stopped: true };
        }
        return { files: files.length, total: files.length, bytesIn, bytesOut, bad, stopped: false };
    }

    /* Decompress the copy beside itself, hash both, throw the scratch file away. */
    readBack(original, copy) {
        const scratch = `${copy}.check`;

        try {
            Gzip.DecompressFile(copy, scratch);
            return File.Hash(scratch) === File.Hash(original);
        } finally {
            if (File.Exists(scratch))
                File.Delete(scratch);
        }
    }
}
