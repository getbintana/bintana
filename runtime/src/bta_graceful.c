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
 * `bta_graceful_fs_rename`, `bta_graceful_fs_remove` and
 * `bta_graceful_fs_write`: the runtime's own writes, renames and deletes of a
 * file it has just made -- `File.Save` and `File.SaveBytes`, `Locale.Write`,
 * `Zip`'s extraction, the `File` keyring provider, `Desktop.Entries`,
 * `File.Rename`, `File.Delete`, `Directory.DeleteTree`, `Http`'s `SaveTo`,
 * `ZipWriter.Finish`, `Gzip`, and `PdfDocument`'s form fields and encryption.
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
 * **Only a refusal for access that a neighbour can end is waited out**, for a
 * second at most, 5 ms doubling. Anything else -- the file is not there, the
 * folder is not writable, or (on Windows) the file is read-only -- is the
 * answer at once: a read-only file is refused there, not held, and waiting
 * does not change it. On POSIX the folder's permission decides, as `unlink`
 * does. A hold that outlasts the second is the refusal it always was, with
 * `errno` as the last try left it.
 */
#include "bta.h"

#include <errno.h>
#include <glib/gstdio.h>

#ifdef G_OS_WIN32
#include <windows.h>

/* The errnos GLib maps a sharing violation and a denied access to. */
static bool held_by_another(int e)
{
    return e == EACCES || e == EPERM || e == EBUSY;
}

/*
 * **A read-only file is not a hold.** Windows answers it the same way it
 * answers a file another process has open -- access denied -- but no amount of
 * waiting changes it. `File.Delete` says so at once, as it did before the
 * retry existed; `DeleteTree`, which takes read-only files, clears the bit
 * first and does not come through here.
 *
 * **A directory is not this.** Microsoft documents `FILE_ATTRIBUTE_READONLY`
 * as "not honored on directories": an empty directory carrying it can still
 * be removed, and Explorer uses the bit only to mark a customized folder. So
 * the check asks for a non-directory.
 */
static bool path_is_read_only(const char *path)
{
    gunichar2 *wide = g_utf8_to_utf16(path, -1, NULL, NULL, NULL);
    if (!wide)
        return false;

    DWORD attrs = GetFileAttributesW((LPCWSTR)wide);
    g_free(wide);
    return attrs != INVALID_FILE_ATTRIBUTES &&
           !(attrs & FILE_ATTRIBUTE_DIRECTORY) &&
           (attrs & FILE_ATTRIBUTE_READONLY);
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

/* A pause that a raised `Cancellable` cuts short: the walk asks between 5 ms
 * slices, so a cancelled delete does not wait out the last half second. */
static bool nap_cancellable(gulong usec, GCancellable *cancel)
{
    while (usec > 0) {
        if (cancel && g_cancellable_is_cancelled(cancel))
            return false;
        gulong step = MIN(usec, 5000);
        g_usleep(step);
        usec -= step;
    }
    return !(cancel && g_cancellable_is_cancelled(cancel));
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
 * `g_remove(path)` -- a file or an empty directory -- waiting out another
 * process that holds it for a moment. `missing_ok` says whether a path that is
 * already gone is success (the `.part` cleanup) or the refusal it is for
 * `File.Delete`, which has always thrown. A raised `cancel` stops the wait and
 * answers ECANCELED. 0, or -1 with `errno`.
 *
 * **On Windows `g_remove` alone cannot see the refusal it waits for.** GLib
 * tries `_wremove` and then `_wrmdir` on every path, and keeps the second
 * call's `errno`: for a file another process holds open, `_wremove` says
 * EACCES and `_wrmdir` -- on something that is not a directory -- overwrites
 * it with EINVAL. That is the "invalid argument" `delete_tree` documents. So
 * when `g_remove` answers EINVAL or ENOTDIR, the path is tried again with
 * `g_unlink`, which asks only the file and keeps the EACCES the retry needs.
 * An empty directory still goes through `g_remove`.
 */
int bta_graceful_fs_remove_cancellable(const char *path, bool missing_ok,
                                       GCancellable *cancel)
{
#ifdef G_OS_WIN32
    if (cancel && g_cancellable_is_cancelled(cancel)) {
        errno = ECANCELED;
        return -1;
    }

    /* A read-only file is the platform's answer, not a hold; waiting out a
     * second would only delay the same refusal. */
    if (path_is_read_only(path)) {
        errno = EACCES;
        return -1;
    }

    gulong wait = 5000, spent = 0;

    for (;;) {
        if (cancel && g_cancellable_is_cancelled(cancel)) {
            errno = ECANCELED;
            return -1;
        }
        if (g_remove(path) == 0)
            return 0;

        int e = errno;

        /* The rmdir half of g_remove masks a file's refusal. `g_unlink` asks
         * the file alone and leaves EACCES, which held_by_another knows. */
        if (e == EINVAL || e == ENOTDIR) {
            if (g_unlink(path) == 0)
                return 0;
            e = errno;
        }

        if (e == ENOENT) {
            if (missing_ok)
                return 0;
            errno = e;
            return -1;
        }

        gulong pause = held_by_another(e) ? held_wait(&wait, &spent) : 0;
        if (!pause) {
            errno = e;
            return -1;
        }
        if (!nap_cancellable(pause, cancel)) {
            errno = ECANCELED;
            return -1;
        }
    }
#else
    if (cancel && g_cancellable_is_cancelled(cancel)) {
        errno = ECANCELED;
        return -1;
    }
    if (g_remove(path) == 0)
        return 0;
    if (missing_ok && errno == ENOENT)
        return 0;
    return -1;
#endif
}

int bta_graceful_fs_remove(const char *path, bool missing_ok)
{
    return bta_graceful_fs_remove_cancellable(path, missing_ok, NULL);
}

/*
 * `g_file_set_contents(path, data, len)` -- a temporary beside it, renamed
 * over -- waiting out another process that holds the target for a moment.
 *
 * **`File.Save` was the one writer with a retry of its own**, 315 ms in all,
 * while the renames and deletes around it waited a second: four tasks saving
 * one file under a `Lock` failed inside `tests/widgets` (the book stopped at
 * 105 of 160) with the shorter budget, and a read-only target spent all of it
 * before saying no. This is that retry, with the duration and the read-only
 * rule of the others; the rename inside `g_file_set_contents` is not visible
 * to the caller, which is why the write has a function of its own.
 */
bool bta_graceful_fs_write(const char *path, const char *data, gssize len,
                           GError **error)
{
#ifdef G_OS_WIN32
    gulong wait = 5000, spent = 0;
    GError *refused = NULL;

    for (;;) {
        g_clear_error(&refused);
        if (g_file_set_contents(path, data, len, &refused))
            return true;

        /* A read-only target answers access denied as a held one does, and no
         * neighbour will let go: it is the answer at once. */
        if (!g_error_matches(refused, G_FILE_ERROR, G_FILE_ERROR_ACCES) ||
            path_is_read_only(path))
            break;

        gulong pause = held_wait(&wait, &spent);
        if (!pause)
            break;
        g_usleep(pause);
    }

    if (error)
        *error = refused;
    else
        g_clear_error(&refused);
    return false;
#else
    return g_file_set_contents(path, data, len, error);
#endif
}
