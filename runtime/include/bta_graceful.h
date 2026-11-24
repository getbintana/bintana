/*
 * Graceful operations (`bta_graceful.c`): the system calls that the platform
 * refuses for a moment under ordinary conditions, and that the runtime
 * therefore waits out instead of failing on. The name and the idea are npm's
 * `graceful-fs`. Each function says which refusal it waits out, for how long,
 * and what it measured.
 *
 * A separate header because `PdfDocument`'s PoDoFo bridge is C++ and must not
 * pull GTK and QuickJS in with `bta.h`; the declarations are the ones both
 * languages share.
 */
#ifndef BTA_GRACEFUL_H
#define BTA_GRACEFUL_H

#include <stdbool.h>

#include <gio/gio.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Graceful `g_rename` and `g_remove`: on Windows a refusal for access -- the
 * antivirus, the indexer or OneDrive holding a file just closed -- is waited
 * out for up to a second instead of failing. One call elsewhere. 0, or -1 with
 * `errno`. On Windows `bta_graceful_fs_remove` does not wait for a read-only
 * file: it is the platform's answer, and fails at once with EACCES; the
 * attribute is not honored on directories, so an empty one still goes. On
 * POSIX the folder's permission decides, as `unlink` does. It takes a file or
 * an empty directory; `missing_ok` says a path already gone is success (the
 * `.part` cleanup) rather than ENOENT (`File.Delete`).
 */
int bta_graceful_fs_rename(const char *from, const char *to);
int bta_graceful_fs_remove(const char *path, bool missing_ok);

/* The same, for a walk that can be cancelled: a raised `Cancellable` stops the
 * wait before its next pause, and answers ECANCELED. */
int bta_graceful_fs_remove_cancellable(const char *path, bool missing_ok,
                                       GCancellable *cancel);

/*
 * Graceful `g_file_set_contents`: a read-only target on Windows is refused at
 * once, and a write another program holds a moment is tried again for up to a
 * second, as the renames are. One call elsewhere.
 */
bool bta_graceful_fs_write(const char *path, const char *data, gssize len,
                           GError **error);

#ifdef __cplusplus
}
#endif

#endif /* BTA_GRACEFUL_H */
