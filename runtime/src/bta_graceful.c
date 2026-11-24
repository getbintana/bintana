/*
 * Graceful operations: the system calls that the platform refuses for a moment
 * under ordinary conditions, and that the runtime therefore waits out instead
 * of failing on. The name and the idea are npm's `graceful-fs`. **What belongs
 * here** is a refusal that is transient, and that the operating system or a
 * neighbour on the machine causes, not the program: each function says which
 * refusal it waits out, for how long, and what it measured. A refusal that is
 * the answer -- a missing file, a folder that is not writable -- never waits.
 * Each area takes a prefix: `bta_graceful_fs_*` for files.
 *
 * ---------------------------------------------------------------- files
 *
 * `bta_graceful_fs_rename` and `bta_graceful_fs_remove`: every rename and
 * delete the runtime does of a file it has just written goes through them.
 *
 * **Why.** On Windows a file that another process has open without
 * `FILE_SHARE_DELETE` cannot be renamed or deleted -- and the antivirus, the
 * search indexer and OneDrive open a file the moment it is closed, to scan or
 * index or upload it. So the runtime's own "write a temporary, close it, rename
 * it into place" was refused with *permission denied* now and then:
 *
 * - `Http`'s `SaveTo`, renaming the finished `.part` -- and, cancelled, failing
 *   to delete it, so a `.part` stayed behind;
 * - `ZipWriter.Finish` and `Gzip`, renaming the archive they built;
 * - the `File` keyring provider, renaming the secret it wrote;
 * - `File.Rename`, when the file had just been written.
 *
 * Measured 2026-11-24 (Windows 11, Defender's real-time protection on): never
 * with one program alone -- 0 failures in 14 400 write-and-renames from six
 * processes at once -- and in two of three runs of the whole `tests/widgets`,
 * whose load makes each scan take longer. With these two functions, the next
 * runs showed none. `testRenameHeld` holds a file from a second process for
 * 400 ms and asserts the rename waits it out; before, it failed at once.
 * Git for Windows and npm's `graceful-fs` wait the same way for the same
 * reason. Linux and macOS rename and delete an open file, so there both are
 * one call.
 *
 * **Only a refusal for access is waited out**, for a second at most, 5 ms
 * doubling. Anything else -- the file is not there, the folder is not
 * writable -- is the answer at once, and a hold that outlasts the second is
 * the refusal it always was, with `errno` as the last try left it.
 */
#include "bta.h"

#include <errno.h>
#include <glib/gstdio.h>

#ifdef G_OS_WIN32
/* The errnos GLib maps a sharing violation and a denied access to. */
static bool held_by_another(int e)
{
    return e == EACCES || e == EPERM || e == EBUSY;
}

/* The next pause, or 0 once a second has been spent. */
static gulong held_wait(gulong *wait, gulong *spent)
{
    const gulong budget = 1000000;      /* microseconds */

    if (*spent >= budget)
        return 0;
    gulong now = MIN(*wait, budget - *spent);
    *spent += now;
    *wait  *= 2;
    return now;
}
#endif

/*
 * `g_rename(from, to)`, waiting out another process that holds `from` or
 * `to` for a moment. 0, or -1 with `errno`. Replaces `to` when it exists, as
 * `g_rename` does.
 */
int bta_graceful_fs_rename(const char *from, const char *to)
{
#ifdef G_OS_WIN32
    gulong wait = 5000, spent = 0;

    for (;;) {
        if (g_rename(from, to) == 0)
            return 0;

        int    e     = errno;
        gulong pause = held_by_another(e) ? held_wait(&wait, &spent) : 0;

        if (!pause) {
            errno = e;
            return -1;
        }
        g_usleep(pause);
    }
#else
    return g_rename(from, to);
#endif
}

/*
 * `g_remove(path)`, waiting out another process that holds it for a moment.
 * 0 -- a file that is already gone included, since gone is what was asked --
 * or -1 with `errno`.
 */
int bta_graceful_fs_remove(const char *path)
{
#ifdef G_OS_WIN32
    gulong wait = 5000, spent = 0;

    for (;;) {
        if (g_remove(path) == 0)
            return 0;

        int e = errno;
        if (e == ENOENT)
            return 0;

        gulong pause = held_by_another(e) ? held_wait(&wait, &spent) : 0;
        if (!pause) {
            errno = e;
            return -1;
        }
        g_usleep(pause);
    }
#else
    if (g_remove(path) == 0 || errno == ENOENT)
        return 0;
    return -1;
#endif
}
