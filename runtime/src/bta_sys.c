/*
 * File, Dir and Exec.
 *
 * The IDE needs to list a project, read and write its files, and run it while
 * showing the output -- so these are runtime features, not IDE plumbing.
 *
 * Exec takes an argv array and never a shell string: there is no shell to
 * quote for, so a filename with a space or a quote cannot turn into a command.
 */
#include "bta.h"

#include <glib/gstdio.h>

#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

/*
 * The two things here that are Unix and not POSIX.
 *
 * `GUnixInputStream` is what this side reads an `Exec`'s third stream with: a
 * pipe whose writing end becomes descriptor 3 in the child.  Windows has no
 * `GUnixInputStream` and no descriptor a child inherits by number -- see
 * `exec_control_fd`, which refuses that stream out loud there rather than
 * accepting a callback that would never be called.  `uname` is the other one;
 * `env_os` asks GLib instead where it does not exist.
 */
#ifndef G_OS_WIN32
#include <gio/gunixinputstream.h>
#include <sys/utsname.h>
#endif

#ifdef G_OS_WIN32
#include <windows.h>
#endif

/*
 * Where this binary is, which every platform answers its own way: `/proc` on
 * Linux, `GetModuleFileName` on Windows.
 *
 * One helper because two callers ask it and neither may drift from the other:
 * the runtime re-invokes itself (`Application.Executable`, which the IDE
 * spawns a project with) and finds its libraries one hop from the binary
 * (`lib_candidates`).  A path that resolves in one of those and not the other
 * is a program that runs but cannot `uses` anything.
 *
 * NULL when it cannot be known, which is a state both callers handle: the
 * library search falls back to its other five places, and `Executable` answers
 * the bare word `bintana`.
 */
char *bta_exe_path(void)
{
#ifdef G_OS_WIN32
    wchar_t wide[32768];
    DWORD   n = GetModuleFileNameW(NULL, wide, G_N_ELEMENTS(wide));

    if (n == 0 || n >= G_N_ELEMENTS(wide))
        return NULL;
    return g_utf16_to_utf8((const gunichar2 *)wide, (glong)n, NULL, NULL, NULL);
#else
    return g_file_read_link("/proc/self/exe", NULL);
#endif
}

/* ------------------------------------------------------------------ File */

static JSValue sys_file_load(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "File.Load(path) needs a path");

    char   *data = NULL;
    gsize   len  = 0;
    GError *err  = NULL;

    if (!g_file_get_contents(path, &data, &len, &err)) {
        JSValue e = JS_ThrowInternalError(ctx, "cannot read %s: %s", path,
                                          err ? err->message : "unknown error");
        g_clear_error(&err);
        JS_FreeCString(ctx, path);
        return e;
    }
    JS_FreeCString(ctx, path);

    JSValue v = JS_NewStringLen(ctx, data, len);
    g_free(data);
    return v;
}

static JSValue sys_file_save(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "File.Save(path, text) needs a path");

    size_t      len  = 0;
    const char *text = argc > 1 ? JS_ToCStringLen(ctx, &len, argv[1]) : NULL;
    if (!text) {
        JS_FreeCString(ctx, path);
        return JS_ThrowTypeError(ctx, "File.Save(path, text) needs text");
    }

    GError *err = NULL;
    bool ok = g_file_set_contents(path, text, len, &err);

    JS_FreeCString(ctx, text);
    if (!ok) {
        JSValue e = JS_ThrowInternalError(ctx, "cannot write %s: %s", path,
                                          err ? err->message : "unknown error");
        g_clear_error(&err);
        JS_FreeCString(ctx, path);
        return e;
    }
    JS_FreeCString(ctx, path);
    return JS_UNDEFINED;
}

enum { FT_EXISTS, FT_ISDIR };

static JSValue sys_file_test(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv, int magic)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_NewBool(ctx, false);

    bool r = g_file_test(path, magic == FT_ISDIR ? G_FILE_TEST_IS_DIR
                                                 : G_FILE_TEST_EXISTS);
    JS_FreeCString(ctx, path);
    return JS_NewBool(ctx, r);
}

/* Purely lexical, so it also works for a path that does not exist yet. */
static JSValue sys_file_absolute(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "File.Absolute(path) needs a path");

    char   *abs = g_canonicalize_filename(path, NULL);
    JSValue v   = JS_NewString(ctx, abs);
    g_free(abs);
    JS_FreeCString(ctx, path);
    return v;
}

/*
 * Path parts, and the names are prefixed for a reason worth keeping: this file
 * includes `windows.h` on Windows, which is a macro minefield -- `PP_NAME` is
 * `4` there (`wincrypt.h`), so a plain `enum { PP_NAME, PP_DIR, ... }` is
 * `expected identifier before numeric constant` and every constant after it is
 * never declared.  Ours are ours.
 */
enum { BTA_PATH_NAME, BTA_PATH_DIR, BTA_PATH_EXT, BTA_PATH_BASENAME };

static JSValue sys_path_part(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv, int magic)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "a path is required");

    char   *out = NULL;
    JSValue v;

    switch (magic) {
    case BTA_PATH_NAME:
        out = g_path_get_basename(path);
        break;
    case BTA_PATH_DIR:
        out = g_path_get_dirname(path);
        break;
    case BTA_PATH_EXT: {
        const char *dot = strrchr(path, '.');
        const char *sep = strrchr(path, G_DIR_SEPARATOR);
        out = (dot && (!sep || dot > sep)) ? g_strdup(dot + 1) : g_strdup("");
        break;
    }
    default: {
        char       *base = g_path_get_basename(path);
        const char *dot  = strrchr(base, '.');
        out = dot && dot != base ? g_strndup(base, dot - base) : g_strdup(base);
        g_free(base);
        break;
    }
    }
    JS_FreeCString(ctx, path);

    v = JS_NewString(ctx, out);
    g_free(out);
    return v;
}

static JSValue sys_file_join(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    GPtrArray *parts = g_ptr_array_new_with_free_func(g_free);

    for (int i = 0; i < argc; i++) {
        const char *s = JS_ToCString(ctx, argv[i]);
        if (!s) {
            g_ptr_array_unref(parts);
            return JS_EXCEPTION;
        }
        g_ptr_array_add(parts, g_strdup(s));
        JS_FreeCString(ctx, s);
    }
    g_ptr_array_add(parts, NULL);

    char   *joined = g_build_filenamev((char **)parts->pdata);
    JSValue v      = JS_NewString(ctx, joined);
    g_free(joined);
    g_ptr_array_unref(parts);
    return v;
}

static JSValue sys_file_rename(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    const char *from = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    const char *to   = argc > 1 ? JS_ToCString(ctx, argv[1]) : NULL;

    if (!from || !to) {
        JS_FreeCString(ctx, from);
        JS_FreeCString(ctx, to);
        return JS_ThrowTypeError(ctx, "File.Rename(from, to) needs both paths");
    }

    /* Refuse to clobber: renaming over an existing file loses it silently. */
    JSValue e = JS_UNDEFINED;
    if (g_file_test(to, G_FILE_TEST_EXISTS))
        e = JS_ThrowInternalError(ctx, "%s already exists", to);
    else if (g_rename(from, to) != 0)
        e = JS_ThrowInternalError(ctx, "cannot rename %s to %s", from, to);

    JS_FreeCString(ctx, from);
    JS_FreeCString(ctx, to);
    return e;
}

/*
 * File.Copy(from, to)
 *
 * **The only way to copy a file that is not text.** `Load` hands back a JS
 * string and `Save` writes one, which is exactly right for source and exactly
 * wrong for a PNG: the bytes go through a text decoding that does not survive
 * them. There was no other road -- a project could read its own image and had no
 * way to put one anywhere.
 *
 * Refuses to clobber, like `Rename` and for the same reason: overwriting is a
 * thing one means to do, and doing it by accident is silent.
 */
static JSValue sys_file_copy(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    const char *from = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    const char *to   = argc > 1 ? JS_ToCString(ctx, argv[1]) : NULL;

    if (!from || !to) {
        JS_FreeCString(ctx, from);
        JS_FreeCString(ctx, to);
        return JS_ThrowTypeError(ctx, "File.Copy(from, to) needs both paths");
    }

    JSValue e = JS_UNDEFINED;
    if (g_file_test(to, G_FILE_TEST_EXISTS)) {
        e = JS_ThrowInternalError(ctx, "%s already exists", to);
    } else {
        GFile  *src = g_file_new_for_path(from);
        GFile  *dst = g_file_new_for_path(to);
        GError *error = NULL;

        if (!g_file_copy(src, dst, G_FILE_COPY_NONE, NULL, NULL, NULL, &error))
            e = JS_ThrowInternalError(ctx, "cannot copy %s to %s: %s", from, to,
                                      error ? error->message : "unknown error");
        g_clear_error(&error);
        g_object_unref(src);
        g_object_unref(dst);
    }

    JS_FreeCString(ctx, from);
    JS_FreeCString(ctx, to);
    return e;
}

/*
 * File.Info(path) -- what the desktop knows about a file, in one call.
 *
 * `{ Size, Modified, Type, Icon, IsDir }`, or `null` when there is no such file.
 *
 * All five come from one `g_file_query_info`, which is the point: asking the
 * size, the time and the type separately is three trips through the filesystem
 * for one answer, and the two that are *not* obvious are the ones worth having.
 *
 *   Type   the content type -- "image/png", "text/x-javascript". A *value*, not
 *          a description: GIO's human-readable one is translated by GIO into
 *          the desktop's language, which is prose no catalogue of ours could
 *          reach and nothing could test against.
 *
 *   Icon   the name the desktop draws for that kind of file. Which is what a
 *          file tree wants and what one otherwise writes a table for -- the
 *          IDE's own has a row per category, and every row is a guess at what
 *          the theme calls things.
 *
 * `Modified` is a real `Date` rather than a number: it is a moment, and every
 * question one asks of it (is this newer than what I read?) is a comparison
 * `Date` already does.
 */
static JSValue sys_file_info(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "File.Info(path) needs a path");

    GFile     *file = g_file_new_for_path(path);
    GFileInfo *info = g_file_query_info(file,
        G_FILE_ATTRIBUTE_STANDARD_SIZE "," G_FILE_ATTRIBUTE_STANDARD_TYPE ","
        G_FILE_ATTRIBUTE_STANDARD_CONTENT_TYPE "," G_FILE_ATTRIBUTE_STANDARD_ICON ","
        G_FILE_ATTRIBUTE_TIME_MODIFIED "," G_FILE_ATTRIBUTE_TIME_MODIFIED_USEC,
        G_FILE_QUERY_INFO_NONE, NULL, NULL);

    g_object_unref(file);
    JS_FreeCString(ctx, path);

    /* Absent is an ordinary state and not a fault: asking about a file that is
     * not there is how one finds out that it is not there. */
    if (!info)
        return JS_NULL;

    JSValue out = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, out, "Size",
                      JS_NewInt64(ctx, g_file_info_get_size(info)));
    JS_SetPropertyStr(ctx, out, "IsDir",
                      JS_NewBool(ctx, g_file_info_get_file_type(info)
                                          == G_FILE_TYPE_DIRECTORY));

    const char *type = g_file_info_get_content_type(info);
    JS_SetPropertyStr(ctx, out, "Type", JS_NewString(ctx, type ? type : ""));

    /*
     * To the millisecond, which is what a Date is.  Truncating to the second --
     * `g_date_time_to_unix` alone, which is what this did -- makes two saves
     * inside one second the same instant, and anything comparing a file against
     * what it read a moment ago then sees no change.  The microseconds cost one
     * more attribute in the query.
     */
    GDateTime *when = g_file_info_get_modification_date_time(info);
    JS_SetPropertyStr(ctx, out, "Modified",
                      when ? JS_NewDate(ctx, (double)g_date_time_to_unix(when) * 1000.0 +
                                             g_date_time_get_microsecond(when) / 1000.0)
                           : JS_NULL);
    if (when)
        g_date_time_unref(when);

    /*
     * A themed icon is a *list*, best first, and the desktop is expected to try
     * them in order -- so what is handed back is the first name this theme
     * really draws, by the same rule everything else here follows.
     */
    const char *icon_name = NULL;
    GIcon      *icon      = g_file_info_get_icon(info);

    if (G_IS_THEMED_ICON(icon)) {
        const char * const *names = g_themed_icon_get_names(G_THEMED_ICON(icon));
        for (int i = 0; names && names[i] && !icon_name; i++)
            if (bta_icon_available(NULL, names[i]))
                icon_name = names[i];
    }
    JS_SetPropertyStr(ctx, out, "Icon", JS_NewString(ctx, icon_name ? icon_name : ""));

    g_object_unref(info);
    return out;
}

/*
 * File.Open(path) -- hand it to whatever the desktop opens that kind of file
 * with.
 *
 * The answer to "the IDE cannot edit this" that is not "then you cannot look at
 * it": a `README`, a `.tar` an export left behind, an `.svg` in `icons/`. What
 * opens each of those is the user's own choice, made once in their desktop, and
 * the program that knows it is the desktop.
 *
 * `GtkFileLauncher` and not `g_app_info_launch_default_for_uri`, which is the
 * older road: the launcher goes through the desktop's portal when there is one,
 * which is what makes this work inside a sandbox -- and is the same reason the
 * file choosers here are `GtkFileDialog`.
 *
 * **It answers before the file is open.** Launching is asynchronous and the
 * program that opens it is somebody else's; what this can promise is that the
 * request was made. A file that is not there is refused *here*, because that is
 * the failure a caller can do something about; anything after that goes to the
 * log, named.
 *
 * A web address is not this: `LinkButton` is what hands a URI to the desktop,
 * and giving a *file* verb two meanings would be the wrong place to put it.
 */
static void on_launched(GObject *source, GAsyncResult *result, gpointer data)
{
    GError *error = NULL;
    char   *path  = data;

    if (!gtk_file_launcher_launch_finish(GTK_FILE_LAUNCHER(source), result, &error) &&
        !g_error_matches(error, GTK_DIALOG_ERROR, GTK_DIALOG_ERROR_DISMISSED))
        g_warning("cannot open %s: %s", path,
                  error ? error->message : "no application for it");

    g_clear_error(&error);
    g_free(path);
    g_object_unref(source);
}

static JSValue sys_file_open(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "File.Open(path) needs a path");

    if (!g_file_test(path, G_FILE_TEST_EXISTS)) {
        JSValue e = JS_ThrowInternalError(ctx, "there is no %s to open", path);
        JS_FreeCString(ctx, path);
        return e;
    }

    GFile           *file     = g_file_new_for_path(path);
    GtkFileLauncher *launcher = gtk_file_launcher_new(file);

    /* Transient for whatever window is up, so a portal's chooser is a child of
     * the application rather than a stray dialog. */
    BtaApp    *app    = bta_current_app();
    GtkWindow *parent = app && app->gapp
                            ? gtk_application_get_active_window(app->gapp) : NULL;

    gtk_file_launcher_launch(launcher, parent, NULL, on_launched, g_strdup(path));

    g_object_unref(file);
    JS_FreeCString(ctx, path);
    return JS_UNDEFINED;
}

/* ------------------------------------------------------------- File.Watch
 *
 * Being told when a file changes underneath, which nothing here could ask
 * before: an editor open on a file somebody else rewrote had no way to know,
 * and the only cure was remembering to reload by hand.
 *
 * `File.Watch(path, (event, path) => ...)` answers with something that can be
 * stopped -- the same bargain `Timer.After` makes, and for the same reason: a
 * bare id would have to be kept somewhere by every caller.
 *
 * **Only settled events are reported.** A save is a burst -- CHANGED while the
 * bytes go out, then CHANGES_DONE_HINT -- and an editor that reacted to each
 * would put its notice up mid-write, on a file that is briefly half there. And
 * many editors do not write in place at all: they write a temporary file and
 * rename it over the target, which arrives as a rename or a move rather than as
 * a change. Both roads end in one "Changed".
 */
typedef struct {
    JSContext    *ctx;
    JSValue       cb;
    GFileMonitor *monitor;
    int           id;

    /*
     * Whether this watch is inside its own callback, and whether it was stopped
     * while it was.
     *
     * **A watch is routinely stopped from within its own callback**, and it is
     * not an exotic thing to do: an editor told that its file changed underneath
     * reloads it, and reloading means watching the new file instead -- so `Stop`
     * runs with `on_file_changed` still on the stack, one frame down.
     * `examples/notes` does exactly that, and doing it used to be a segfault:
     * the job was freed and then read back by the lines after the call.
     *
     * So stopping in here only *marks*, and the freeing is done by the frame
     * that owns the job once it is finished with it.
     */
    bool          calling;
    bool          dead;
} WatchJob;

static GList *watch_jobs;    /* WatchJob*, watches in flight */
static int    watch_next_id = 1;

static void watch_job_free(WatchJob *job)
{
    watch_jobs = g_list_remove(watch_jobs, job);

    if (job->monitor) {
        g_signal_handlers_disconnect_by_data(job->monitor, job);
        g_file_monitor_cancel(job->monitor);
        g_object_unref(job->monitor);
    }
    JS_FreeValue(job->ctx, job->cb);
    g_free(job);
}

static const char *watch_event_name(GFileMonitorEvent event)
{
    switch (event) {
    case G_FILE_MONITOR_EVENT_CHANGES_DONE_HINT: return "Changed";
    case G_FILE_MONITOR_EVENT_RENAMED:           return "Changed";
    case G_FILE_MONITOR_EVENT_MOVED_IN:          return "Created";
    case G_FILE_MONITOR_EVENT_CREATED:           return "Created";
    case G_FILE_MONITOR_EVENT_MOVED_OUT:         return "Deleted";
    case G_FILE_MONITOR_EVENT_DELETED:           return "Deleted";
    default:                                     return NULL;
    }
}

static void on_file_changed(GFileMonitor *monitor, GFile *file, GFile *other,
                            GFileMonitorEvent event, gpointer user_data)
{
    WatchJob   *job  = user_data;
    const char *name = watch_event_name(event);
    if (!name)
        return;

    /* The file it ends up being: a rename reports where it went. */
    char *path = g_file_get_path(other && event == G_FILE_MONITOR_EVENT_RENAMED
                                     ? other : file);

    /*
     * The context is taken *before* the call and used after it, and the job is
     * not touched again once `dead` has been read: everything below this line
     * has to keep working for a watch that stopped itself half a frame ago.
     */
    JSContext *ctx = job->ctx;

    JSValue argv[2] = { JS_NewString(ctx, name),
                        JS_NewString(ctx, path ? path : "") };

    job->calling = true;
    JSValue r = JS_Call(ctx, job->cb, JS_UNDEFINED, 2, argv);

    if (JS_IsException(r))
        bta_dump_error(ctx);

    JS_FreeValue(ctx, r);
    JS_FreeValue(ctx, argv[0]);
    JS_FreeValue(ctx, argv[1]);
    bta_drain_jobs(JS_GetRuntime(ctx));   /* which can also stop this watch */

    job->calling = false;
    if (job->dead)
        watch_job_free(job);

    g_free(path);
}

static JSValue sys_watch_stop(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv, int magic,
                              JSValue *func_data)
{
    int32_t id;
    if (JS_ToInt32(ctx, &id, func_data[0]))
        return JS_EXCEPTION;

    for (GList *l = watch_jobs; l; l = l->next) {
        WatchJob *job = l->data;
        if (job->id != id)
            continue;

        /*
         * Stopped from inside its own callback: the frame below is still going
         * to read this job, and it is also inside the monitor's own signal
         * emission -- so cancelling and unreffing the monitor here would pull
         * the ground out from under GLib as well. Mark it, and let that frame
         * do it.
         *
         * The watch stops reporting either way: the mark is read before
         * anything else can arrive, since both live on the same main loop.
         */
        if (job->calling) job->dead = true;
        else              watch_job_free(job);

        break;                           /* stopping twice is not an error */
    }
    return JS_UNDEFINED;
}

static JSValue sys_file_watch(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path || argc < 2 || !JS_IsFunction(ctx, argv[1])) {
        JS_FreeCString(ctx, path);
        return JS_ThrowTypeError(ctx,
            "File.Watch(path, (event, path) => ...) needs a path and a function");
    }

    GFile  *file  = g_file_new_for_path(path);
    GError *error = NULL;
    /* WATCH_MOVES, because a rename over the file is how most editors save. */
    GFileMonitor *monitor = g_file_monitor(file, G_FILE_MONITOR_WATCH_MOVES,
                                           NULL, &error);
    g_object_unref(file);

    if (!monitor) {
        JSValue e = JS_ThrowInternalError(ctx, "cannot watch %s: %s", path,
                                          error ? error->message : "unknown error");
        g_clear_error(&error);
        JS_FreeCString(ctx, path);
        return e;
    }

    WatchJob *job = g_new0(WatchJob, 1);
    job->ctx     = ctx;
    job->cb      = JS_DupValue(ctx, argv[1]);
    job->monitor = monitor;
    job->id      = watch_next_id++;
    watch_jobs   = g_list_prepend(watch_jobs, job);

    g_signal_connect(monitor, "changed", G_CALLBACK(on_file_changed), job);

    JSValue out = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, out, "Path", JS_NewString(ctx, path));

    JSValue id = JS_NewInt32(ctx, job->id);
    JS_SetPropertyStr(ctx, out, "Stop",
                      JS_NewCFunctionData(ctx, sys_watch_stop, 0, 0, 1, &id));
    JS_FreeValue(ctx, id);

    JS_FreeCString(ctx, path);
    return out;
}

static JSValue sys_file_delete(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "File.Delete(path) needs a path");

    bool ok = g_remove(path) == 0;
    JSValue e = ok ? JS_UNDEFINED
                   : JS_ThrowInternalError(ctx, "cannot delete %s", path);
    JS_FreeCString(ctx, path);
    return e;
}

/*
 * File.Trash(path) -- the desktop's undo for "I did not mean that".
 *
 * Deleting is the one operation with no way back, and every file manager on
 * every desktop answers that the same way: the file goes to the trash and the
 * person decides later. A program that offers *Delete* and means `unlink` is
 * offering something harsher than the desktop it runs on.
 *
 * It is not always there, and this says so rather than quietly deleting: a
 * trash lives on the filesystem the file is on, so a project on tmpfs, on a
 * stick or on a share may have none. **The caller decides what to do about
 * that** -- the IDE deletes and says which of the two happened -- because a
 * `Trash` that silently unlinks would be the one thing this is for, gone.
 *
 * A folder goes whole, children and all, which is what GIO does and what the
 * desktop does.
 */
static JSValue sys_file_trash(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "File.Trash(path) needs a path");

    GFile  *file  = g_file_new_for_path(path);
    GError *error = NULL;
    JSValue e     = JS_UNDEFINED;

    if (!g_file_trash(file, NULL, &error))
        e = JS_ThrowInternalError(ctx, "cannot trash %s: %s", path,
                                  error ? error->message : "unknown error");

    g_clear_error(&error);
    g_object_unref(file);
    JS_FreeCString(ctx, path);
    return e;
}

/* ------------------------------------------------------------------- Dir */

/*
 * Copying a folder is copying what is in it, one level at a time.
 *
 * GIO has no recursive copy -- `g_file_copy` is one file -- so this is the
 * walk, and it is here rather than in JS because the loop belongs next to the
 * primitive it repeats. Symbolic links and permissions are the toolkit's
 * business (`G_FILE_COPY_NONE`), which is the same bargain `File.Copy` makes.
 */
static bool copy_tree(GFile *src, GFile *dst, GError **error)
{
    GFileType kind = g_file_query_file_type(src, G_FILE_QUERY_INFO_NONE, NULL);

    if (kind != G_FILE_TYPE_DIRECTORY)
        return g_file_copy(src, dst, G_FILE_COPY_NONE, NULL, NULL, NULL, error);

    if (!g_file_make_directory_with_parents(dst, NULL, error)) {
        /* Already there is not a failure: a caller copying into a tree it is
         * building will meet its own folders on the way down. */
        if (!g_error_matches(*error, G_IO_ERROR, G_IO_ERROR_EXISTS))
            return false;
        g_clear_error(error);
    }

    GFileEnumerator *walk = g_file_enumerate_children(
        src, G_FILE_ATTRIBUTE_STANDARD_NAME, G_FILE_QUERY_INFO_NONE, NULL, error);
    if (!walk)
        return false;

    bool ok = true;
    for (;;) {
        GFileInfo *info = g_file_enumerator_next_file(walk, NULL, error);
        if (!info) {
            ok = (*error == NULL);      /* no more, or the walk itself failed */
            break;
        }

        GFile *from = g_file_get_child(src, g_file_info_get_name(info));
        GFile *to   = g_file_get_child(dst, g_file_info_get_name(info));

        ok = copy_tree(from, to, error);

        g_object_unref(from);
        g_object_unref(to);
        g_object_unref(info);
        if (!ok)
            break;
    }

    g_object_unref(walk);
    return ok;
}

static JSValue sys_dir_copy(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    const char *from = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    const char *to   = argc > 1 ? JS_ToCString(ctx, argv[1]) : NULL;

    if (!from || !to) {
        JS_FreeCString(ctx, from);
        JS_FreeCString(ctx, to);
        return JS_ThrowTypeError(ctx, "Directory.Copy(from, to) needs both paths");
    }

    JSValue e = JS_UNDEFINED;
    if (g_file_test(to, G_FILE_TEST_EXISTS)) {
        /* The same refusal `File.Copy` makes, and for more reason: merging a
         * tree into an existing one is a different operation nobody asked for. */
        e = JS_ThrowInternalError(ctx, "%s already exists", to);
    } else {
        GFile  *src   = g_file_new_for_path(from);
        GFile  *dst   = g_file_new_for_path(to);
        GError *error = NULL;

        if (!copy_tree(src, dst, &error))
            e = JS_ThrowInternalError(ctx, "cannot copy %s to %s: %s", from, to,
                                      error ? error->message : "unknown error");
        g_clear_error(&error);
        g_object_unref(src);
        g_object_unref(dst);
    }

    JS_FreeCString(ctx, from);
    JS_FreeCString(ctx, to);
    return e;
}

/*
 * Two deletes, and the dangerous one says so in its name.
 *
 * `Directory.Delete` takes a folder that is empty and refuses one that is not, which
 * is the operation a program actually reaches for -- "that folder has nothing
 * left in it". `Directory.DeleteTree` takes the folder and everything under it, and
 * spells that out: a recursive delete behind an innocent name is how a wrong
 * path becomes a lost afternoon, and the two are one word apart on purpose.
 */
static bool delete_tree(GFile *dir, GError **error)
{
    GFileEnumerator *walk = g_file_enumerate_children(
        dir, G_FILE_ATTRIBUTE_STANDARD_NAME, G_FILE_QUERY_INFO_NONE, NULL, error);

    /* Not a folder: it is a file, and deleting it is the whole of the job. */
    if (!walk) {
        g_clear_error(error);
        return g_file_delete(dir, NULL, error);
    }

    bool ok = true;
    for (;;) {
        GFileInfo *info = g_file_enumerator_next_file(walk, NULL, error);
        if (!info) {
            ok = (*error == NULL);
            break;
        }

        GFile *child = g_file_get_child(dir, g_file_info_get_name(info));
        ok = delete_tree(child, error);

        g_object_unref(child);
        g_object_unref(info);
        if (!ok)
            break;
    }

    g_object_unref(walk);
    return ok && g_file_delete(dir, NULL, error);
}

static JSValue sys_dir_delete(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "Directory.Delete(path) needs a path");

    bool    ok = g_rmdir(path) == 0;
    JSValue e  = ok ? JS_UNDEFINED
                    : JS_ThrowInternalError(ctx, "cannot delete %s: %s", path,
                                            g_strerror(errno));
    JS_FreeCString(ctx, path);
    return e;
}

static JSValue sys_dir_delete_tree(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "Directory.DeleteTree(path) needs a path");

    JSValue e = JS_UNDEFINED;
    if (!g_file_test(path, G_FILE_TEST_IS_DIR)) {
        /* A file handed to a recursive delete is a path that was computed
         * wrong, and taking it would be doing the wrong thing quietly. */
        e = JS_ThrowInternalError(ctx, "%s is not a folder", path);
    } else {
        GFile  *dir   = g_file_new_for_path(path);
        GError *error = NULL;

        if (!delete_tree(dir, &error))
            e = JS_ThrowInternalError(ctx, "cannot delete %s: %s", path,
                                      error ? error->message : "unknown error");
        g_clear_error(&error);
        g_object_unref(dir);
    }

    JS_FreeCString(ctx, path);
    return e;
}


static JSValue sys_dir_list(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "Directory.List(path) needs a path");

    /* Optional glob, e.g. Directory.List(dir, "*.js"). */
    const char *pattern = argc > 1 && JS_IsString(argv[1])
                              ? JS_ToCString(ctx, argv[1]) : NULL;

    GError *err = NULL;
    GDir   *dir = g_dir_open(path, 0, &err);
    if (!dir) {
        JSValue e = JS_ThrowInternalError(ctx, "cannot list %s: %s", path,
                                          err ? err->message : "unknown error");
        g_clear_error(&err);
        JS_FreeCString(ctx, path);
        JS_FreeCString(ctx, pattern);
        return e;
    }

    GPatternSpec *spec  = pattern ? g_pattern_spec_new(pattern) : NULL;
    GPtrArray    *names = g_ptr_array_new_with_free_func(g_free);
    const char   *name;

    while ((name = g_dir_read_name(dir))) {
        if (spec && !g_pattern_spec_match_string(spec, name))
            continue;
        g_ptr_array_add(names, g_strdup(name));
    }
    g_dir_close(dir);
    if (spec)
        g_pattern_spec_free(spec);

    g_ptr_array_sort_values(names, (GCompareFunc)g_strcmp0);

    JSValue arr = JS_NewArray(ctx);
    for (guint i = 0; i < names->len; i++)
        JS_SetPropertyUint32(ctx, arr, i, JS_NewString(ctx, names->pdata[i]));

    g_ptr_array_unref(names);
    JS_FreeCString(ctx, path);
    JS_FreeCString(ctx, pattern);
    return arr;
}

static JSValue sys_dir_make(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "Directory.Make(path) needs a path");

    bool    ok = g_mkdir_with_parents(path, 0755) == 0;
    JSValue e  = ok ? JS_UNDEFINED
                    : JS_ThrowInternalError(ctx, "cannot create %s", path);
    JS_FreeCString(ctx, path);
    return e;
}

/*
 * Directory.Files(path, [pattern | options]) and Directory.Folders(...).
 *
 * `List` answers what is in one directory, as names, and every caller that
 * wanted more had to build the rest itself: join each name to its directory,
 * ask whether it is a directory, and recurse.  That walk was written by hand
 * three times in the tools of this repository alone -- once to find sources
 * newer than the binary, once to find every `.form`, once to gather every icon
 * of a theme -- which is three chances to get the symlink case wrong.
 *
 * So: **full paths, filtered, and as deep as asked.**
 *
 *   Directory.Files(dir)                          every file in it
 *   Directory.Files(dir, "*.form")                filtered by name
 *   Directory.Files(dir, { Pattern: "*.c", Recursive: true })
 *   Directory.Folders(dir, { Recursive: true })
 *
 * Sorted at each level and depth-first, so two runs list the same tree in the
 * same order -- a walk whose order depends on the filesystem makes a diff of
 * its output useless.
 *
 * **A symlinked directory is listed and not entered.** `find` and Python's
 * `os.walk` both default to this, and for the same reason: a link into a parent
 * is a loop, and an icon theme full of them would be walked forever.  A symlink
 * to a *file* is an ordinary file -- icon themes are largely built out of those,
 * and not counting them would answer a question nobody asked.
 */
static void dir_walk(const char *root, GPatternSpec *spec, bool recursive,
                     bool want_dirs, GPtrArray *out)
{
    GDir *dir = g_dir_open(root, 0, NULL);
    if (!dir)
        return;   /* unreadable: skipped, not fatal -- one corner of /usr must
                   * not end a walk that was about somewhere else */

    GPtrArray  *names = g_ptr_array_new_with_free_func(g_free);
    const char *name;

    while ((name = g_dir_read_name(dir)))
        g_ptr_array_add(names, g_strdup(name));
    g_dir_close(dir);

    g_ptr_array_sort_values(names, (GCompareFunc)g_strcmp0);

    for (guint i = 0; i < names->len; i++) {
        char *full   = g_build_filename(root, names->pdata[i], NULL);
        bool  is_dir = g_file_test(full, G_FILE_TEST_IS_DIR);

        if (is_dir == want_dirs &&
            (!spec || g_pattern_spec_match_string(spec, names->pdata[i])))
            g_ptr_array_add(out, g_strdup(full));

        if (recursive && is_dir && !g_file_test(full, G_FILE_TEST_IS_SYMLINK))
            dir_walk(full, spec, recursive, want_dirs, out);

        g_free(full);
    }
    g_ptr_array_unref(names);
}

static JSValue sys_dir_walk(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv, int magic)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, magic ? "Directory.Folders(path) needs a path"
                                            : "Directory.Files(path) needs a path");

    /* A bare string is the pattern, an object is the options: the short form is
     * what most calls are, and it does not have to carry a key to say so. */
    const char *pattern   = NULL;
    bool        recursive = false;

    if (argc > 1 && JS_IsString(argv[1])) {
        pattern = JS_ToCString(ctx, argv[1]);
    } else if (argc > 1 && JS_IsObject(argv[1])) {
        JSValue p = JS_GetPropertyStr(ctx, argv[1], "Pattern");
        if (JS_IsString(p))
            pattern = JS_ToCString(ctx, p);
        JS_FreeValue(ctx, p);

        JSValue r = JS_GetPropertyStr(ctx, argv[1], "Recursive");
        recursive = JS_ToBool(ctx, r) > 0;
        JS_FreeValue(ctx, r);
    }

    if (!g_file_test(path, G_FILE_TEST_IS_DIR)) {
        JSValue e = JS_ThrowInternalError(ctx, "cannot list %s: not a directory",
                                          path);
        JS_FreeCString(ctx, path);
        JS_FreeCString(ctx, pattern);
        return e;
    }

    GPatternSpec *spec  = pattern ? g_pattern_spec_new(pattern) : NULL;
    GPtrArray    *found = g_ptr_array_new_with_free_func(g_free);

    dir_walk(path, spec, recursive, magic != 0, found);

    JSValue arr = JS_NewArray(ctx);
    for (guint i = 0; i < found->len; i++)
        JS_SetPropertyUint32(ctx, arr, i, JS_NewString(ctx, found->pdata[i]));

    g_ptr_array_unref(found);
    if (spec)
        g_pattern_spec_free(spec);
    JS_FreeCString(ctx, path);
    JS_FreeCString(ctx, pattern);
    return arr;
}

/* ------------------------------------------------------------------ Exec */

/*
 * A running child process.  The JS callbacks are strong references held from
 * C -- the collector cannot see them -- so every exit path must free them,
 * including runtime teardown while the child is still alive.
 */
typedef struct {
    JSContext        *ctx;
    JSValue           on_line;
    JSValue           on_exit;
    /* The handle Exec handed back, so what becomes of the child can be written
     * on it: `Running` and `ExitCode` are answers a caller reads *after* the
     * job itself is gone, which rules out asking the job. */
    JSValue           handle;
    GSubprocess      *proc;
    GDataInputStream *out;
    /* NULL unless the caller asked for the two streams apart; stderr is folded
     * into stdout otherwise, which is what keeps the order. */
    GDataInputStream *err;
    /*
     * The third stream, and the way back.
     *
     * `control` is descriptor 3 in the child, read here a line at a time, for a
     * child that speaks a protocol as well as printing: stdout is what it says
     * to a person and this is what it says to a program. `in` is its stdin,
     * which is what `Write` writes to. Both NULL unless asked for.
     */
    GDataInputStream *control;
    JSValue           on_control;
    GOutputStream    *in;
    GCancellable     *cancel;
    bool              eof;       /* stdout drained */
    bool              err_eof;   /* stderr drained, or there is no second pipe */
    bool              reaped;    /* process exited */
    int               status;
    /* Ours, not the system's: the handle Exec hands back names the job by this
     * and never by the pid, so a Kill after the child is gone finds nothing
     * instead of finding whoever inherited its number. */
    int               id;
    /* The child's pid, which is also its process group -- see exec_child_setup.
     * Kept as a number because that is what killpg takes. */
    pid_t             pid;
    /*
     * The hang guard, in two stages: `guard` asks the child to end and `force`
     * makes it.  Zero when not armed, and **removed in exec_job_free**, which
     * every exit path goes through -- a source left pending on a freed job is
     * the one way this feature could crash.
     */
    guint             guard;
    guint             force;
    unsigned          kill_after;   /* ms between the two stages */
    bool              timed_out;    /* the guard fired, so a nonzero status is ours */
} ExecJob;

static GList *exec_jobs;   /* ExecJob*, live children */
static int    exec_next_id = 1;

static void exec_job_free(ExecJob *job)
{
    exec_jobs = g_list_remove(exec_jobs, job);

    /* Before anything else: a guard that fires on a freed job reads memory that
     * is gone, and it fires on a timer nobody is watching. */
    if (job->guard)
        g_source_remove(job->guard);
    if (job->force)
        g_source_remove(job->force);

    JS_FreeValue(job->ctx, job->on_line);
    JS_FreeValue(job->ctx, job->on_control);
    g_clear_object(&job->control);
    JS_FreeValue(job->ctx, job->on_exit);
    JS_FreeValue(job->ctx, job->handle);
    g_clear_object(&job->out);
    g_clear_object(&job->err);
    g_clear_object(&job->proc);
    g_clear_object(&job->cancel);
    g_free(job);
}

/* Finish only once every pipe and the process are done, so no output is
 * reported after the exit callback. */
static void exec_maybe_finish(ExecJob *job)
{
    if (!job->eof || !job->err_eof || !job->reaped)
        return;

    /* Written before the callback runs, so a handler asking the handle what
     * happened is answered rather than told the child is still running. */
    if (JS_IsObject(job->handle)) {
        JS_SetPropertyStr(job->ctx, job->handle, "Running", JS_FALSE);
        JS_SetPropertyStr(job->ctx, job->handle, "ExitCode",
                          JS_NewInt32(job->ctx, job->status));
    }

    if (JS_IsFunction(job->ctx, job->on_exit)) {
        JSValue arg = JS_NewInt32(job->ctx, job->status);
        JSValue r   = JS_Call(job->ctx, job->on_exit, JS_UNDEFINED, 1, &arg);
        if (JS_IsException(r))
            bta_dump_error(job->ctx);
        JS_FreeValue(job->ctx, r);
        JS_FreeValue(job->ctx, arg);
        bta_drain_jobs(JS_GetRuntime(job->ctx));
    }
    exec_job_free(job);
}

/*
 * Ending a child, which is two verbs on Unix and one on Windows.
 *
 * POSIX: SIGTERM or SIGKILL to the child's whole group, falling back to the
 * process alone when the group is already gone -- which it can be, with the
 * leader exited and only what it started left.
 *
 * Windows: **there is no asking.** `Stop()` and `Kill()` are both
 * `g_subprocess_force_exit`, because the platform has no SIGTERM for a process
 * that is not looking at a console window, and a program that offers a
 * graceful stop it cannot deliver is worse than one that says it cannot.  The
 * process group is gone too: this reaches the child and not what a wrapper
 * started under it, which is the documented cost and the reason the runner's
 * hang guard is the thing to test Windows with.
 */
static void exec_signal_group(GSubprocess *proc, pid_t pid, bool force)
{
#ifdef G_OS_WIN32
    (void)force;
    if (proc)
        g_subprocess_force_exit(proc);
#else
    int sig = force ? SIGKILL : SIGTERM;

    if (pid <= 0)
        return;
    if (killpg(pid, sig) != 0)
        kill(pid, sig);
#endif
}

/*
 * The second stage: what nothing can decline.  The group and not the process,
 * for the reason exec_child_setup exists -- a child is usually a wrapper, and
 * signalling only the wrapper leaves what it started running.
 */
static gboolean on_exec_force(gpointer data)
{
    ExecJob *job = data;

    job->force = 0;
    if (!job->reaped)
        exec_signal_group(job->proc, job->pid, true);
    return G_SOURCE_REMOVE;
}

/*
 * The first stage: asked to end, and told on the handle that it was.
 *
 * `TimedOut` is the half that makes this worth having in the runtime rather than
 * in every caller: without it a guard leaves an exit status that looks like an
 * ordinary failure, and whoever wants to say "timed out" has to keep a flag of
 * its own -- which is exactly the bookkeeping the test runner had.
 */
static gboolean on_exec_guard(gpointer data)
{
    ExecJob *job = data;

    job->guard = 0;
    if (job->reaped || job->pid <= 0)
        return G_SOURCE_REMOVE;

    job->timed_out = true;
    if (JS_IsObject(job->handle))
        JS_SetPropertyStr(job->ctx, job->handle, "TimedOut", JS_TRUE);

    exec_signal_group(job->proc, job->pid, false);

    /* Zero means do not wait at all: SIGTERM and SIGKILL together, for a caller
     * that has no use for a graceful ending. */
    if (job->kill_after == 0)
        return on_exec_force(job);

    job->force = g_timeout_add(job->kill_after, on_exec_force, job);
    return G_SOURCE_REMOVE;
}

static void exec_read_next(ExecJob *job, GDataInputStream *from);

static void on_exec_line(GObject *src, GAsyncResult *res, gpointer user_data)
{
    ExecJob *job = user_data;
    GError  *err = NULL;
    gsize    len = 0;

    /* Which pipe answered.  The stream itself says so, which is why nothing has
     * to be allocated to carry it: the two reads are told apart by the object
     * the callback is already given. */
    GDataInputStream *stream = G_DATA_INPUT_STREAM(src);
    bool              is_err = job->err && stream == job->err;
    bool              is_ctl = job->control && stream == job->control;

    char *line = g_data_input_stream_read_line_finish_utf8(stream, res, &len, &err);

    if (g_error_matches(err, G_IO_ERROR, G_IO_ERROR_CANCELLED)) {
        g_clear_error(&err);
        g_free(line);
        return;   /* teardown already freed the job */
    }
    g_clear_error(&err);

    if (!line) {
        /* The control stream ending is not the child ending: it closes when the
           program stops speaking the protocol, and what says the run is over is
           still stdout draining and the process being reaped. */
        if (is_ctl)
            return;
        if (is_err)
            job->err_eof = true;
        else
            job->eof = true;
        exec_maybe_finish(job);
        return;
    }

    if (is_ctl) {
        if (JS_IsFunction(job->ctx, job->on_control)) {
            JSValue arg = JS_NewString(job->ctx, line);
            JSValue r   = JS_Call(job->ctx, job->on_control, JS_UNDEFINED, 1,
                                  (JSValueConst *)&arg);
            if (JS_IsException(r))
                bta_dump_error(job->ctx);
            JS_FreeValue(job->ctx, r);
            JS_FreeValue(job->ctx, arg);
        }
        g_free(line);
        exec_read_next(job, stream);
        return;
    }

    if (JS_IsFunction(job->ctx, job->on_line)) {
        /* The second argument only exists when the streams were kept apart:
         * with them merged there is no honest answer to "which was this",
         * and inventing "out" for a line that came from stderr would be one. */
        JSValue argv[2] = { JS_NewString(job->ctx, line),
                            job->err ? JS_NewString(job->ctx, is_err ? "err" : "out")
                                     : JS_UNDEFINED };
        JSValue r = JS_Call(job->ctx, job->on_line, JS_UNDEFINED,
                            job->err ? 2 : 1, (JSValueConst *)argv);
        if (JS_IsException(r))
            bta_dump_error(job->ctx);
        JS_FreeValue(job->ctx, r);
        JS_FreeValue(job->ctx, argv[0]);
        JS_FreeValue(job->ctx, argv[1]);
    }
    g_free(line);

    exec_read_next(job, stream);
}

static void exec_read_next(ExecJob *job, GDataInputStream *from)
{
    g_data_input_stream_read_line_async(from, G_PRIORITY_DEFAULT,
                                        job->cancel, on_exec_line, job);
}

static void on_exec_done(GObject *src, GAsyncResult *res, gpointer user_data)
{
    ExecJob *job = user_data;
    GError  *err = NULL;

    if (!g_subprocess_wait_finish(G_SUBPROCESS(src), res, &err)) {
        if (g_error_matches(err, G_IO_ERROR, G_IO_ERROR_CANCELLED)) {
            g_clear_error(&err);
            return;
        }
        g_clear_error(&err);
    }

    job->status = g_subprocess_get_if_exited(job->proc)
                      ? g_subprocess_get_exit_status(job->proc) : -1;
    job->reaped = true;
    exec_maybe_finish(job);
}

/*
 * How long the caller will wait, and how long after that it stops asking.
 *
 * Two stages and not one, because a well-behaved program answers SIGTERM by
 * cleaning up after itself and that is worth waiting for: `xvfb-run` is a shell
 * script that takes its X server down when asked, and killing it outright leaves
 * the server orphaned to init -- which is the bug the process-group comment
 * below was written for, arriving from the other direction.  It is what
 * coreutils spells `timeout --kill-after`, and what the test runner wrote by
 * hand before this existed.
 *
 * Milliseconds, because `Timer` counts in milliseconds.  `KillAfter` defaults to
 * the five seconds the runner had chosen for the same reason.
 */
#define EXEC_KILL_AFTER 5000

static unsigned exec_millis(JSContext *ctx, JSValueConst opts, const char *key,
                            unsigned fallback)
{
    if (JS_IsUndefined(opts))
        return fallback;

    JSValue v = JS_GetPropertyStr(ctx, opts, key);
    unsigned out = fallback;

    if (JS_IsNumber(v)) {
        double ms = 0;
        JS_ToFloat64(ctx, &ms, v);
        out = ms > 0 ? (unsigned)ms : 0;
    }
    JS_FreeValue(ctx, v);
    return out;
}

/* Whether the caller asked for the two output streams apart. */
static bool exec_wants_split(JSContext *ctx, JSValueConst opts)
{
    if (JS_IsUndefined(opts))
        return false;

    JSValue v = JS_GetPropertyStr(ctx, opts, "Stderr");
    bool    split = false;

    if (JS_IsString(v)) {
        const char *how = JS_ToCString(ctx, v);
        split = how && !strcmp(how, "separate");
        JS_FreeCString(ctx, how);
    }
    JS_FreeValue(ctx, v);
    return split;
}

/*
 * `{ Directory, Environment, Stderr }`: where to start the child, what to change in the
 * environment it inherits -- a name with a value is set, a name with `null` is
 * removed, and everything else comes through untouched -- and whether its two
 * output streams are kept apart.
 *
 * A *whole* environment is deliberately not offered.  What a caller has is the
 * environment it got plus a change to it, and spelling that as a replacement
 * means writing out PATH, HOME and DISPLAY by hand in order to keep them --
 * three chances to lose one, for a case nobody has.
 */
static void exec_apply_options(JSContext *ctx, JSValueConst opts,
                               GSubprocessLauncher *launcher)
{
    JSValue dir = JS_GetPropertyStr(ctx, opts, "Directory");
    if (JS_IsString(dir)) {
        const char *s = JS_ToCString(ctx, dir);
        if (s) {
            g_subprocess_launcher_set_cwd(launcher, s);
            JS_FreeCString(ctx, s);
        }
    }
    JS_FreeValue(ctx, dir);

    JSValue env = JS_GetPropertyStr(ctx, opts, "Environment");
    if (JS_IsObject(env)) {
        JSPropertyEnum *tab = NULL;
        uint32_t        len = 0;

        if (JS_GetOwnPropertyNames(ctx, &tab, &len, env,
                                   JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) == 0) {
            for (uint32_t i = 0; i < len; i++) {
                const char *name = JS_AtomToCString(ctx, tab[i].atom);
                JSValue     v    = JS_GetProperty(ctx, env, tab[i].atom);

                if (name && (JS_IsNull(v) || JS_IsUndefined(v))) {
                    g_subprocess_launcher_unsetenv(launcher, name);
                } else if (name) {
                    const char *val = JS_ToCString(ctx, v);
                    if (val) {
                        g_subprocess_launcher_setenv(launcher, name, val, TRUE);
                        JS_FreeCString(ctx, val);
                    }
                }
                JS_FreeCString(ctx, name);
                JS_FreeValue(ctx, v);
            }
            JS_FreePropertyEnum(ctx, tab, len);
        }
    }
    JS_FreeValue(ctx, env);
}

/*
 * Every child leads a process group of its own.
 *
 * Which is what makes `Kill` mean what it says.  A child is often a wrapper --
 * `xvfb-run`, `make`, a shell one-liner -- and signalling only the wrapper
 * leaves what it started running: the test runner's hang guard killed
 * `xvfb-run` and left its X server behind, orphaned to init, once per timeout.
 * Signalling the group reaches all of it.
 *
 * It also stops a signal travelling the other way: a child in its own group
 * does not get the Ctrl-C meant for the program that started it.  The cost is a
 * child with no controlling terminal, which matters only to something
 * interactive -- and interactive is `Terminal`, which has a real pty.
 *
 * Runs between fork and exec, so nothing here may allocate or take a lock.
 *
 * **Unix only, and so is the call that installs it**: `g_subprocess_launcher_
 * set_child_setup` is part of GLib's Unix API and does not exist on Windows.
 * There the child is a Windows process in Windows' own group, which is
 * `exec_signal_group`'s problem and not one a `setsid` could solve.
 */
#ifndef G_OS_WIN32
static void exec_child_setup(gpointer user_data)
{
    setsid();
}
#endif

/*
 * Ask a child to stop, or make it.
 *
 * **Two verbs and no flag**: `Stop()` sends SIGTERM, which is a request a
 * well-behaved program answers by exiting, and `Kill()` sends SIGKILL, which
 * nothing can decline.  `Stop` is also what `Timer` calls ending a timer, so
 * the word means the same thing in both places.
 *
 * A boolean would have been worse than verbose here: .NET spells the same
 * handle's `Kill(true)` as *and everything it started*, and ours would have
 * meant *and harder* -- the same call, read by the same person, meaning two
 * different things.  What .NET puts behind that flag we do always: both signals
 * go to the child's whole process group (above).
 *
 * Both report whether there was still something to signal, because a child that
 * already exited is the ordinary case for a guard that fires late, not an
 * error.  The exit callback runs either way, with the status the exit really
 * had: a child stopped by a signal did not exit, so its status is -1 and the
 * difference between "failed" and "was stopped" is known to whoever stopped it.
 */
/*
 * Say something to a child.
 *
 * `Stop` and `Kill` are the two things that could be said to one before this,
 * and both of them end it.  What was missing was the ordinary thing: a child
 * that reads a line and answers -- a debugger, a compiler with a REPL, `sort`.
 *
 * A newline is added when there is not one, because a line is what the other
 * side is waiting on and a `Write` without one hangs both of them for a reason
 * that is invisible from either side.  It answers whether there was still a
 * child to write to, the way `Stop` and `Kill` do, so a caller that races the
 * exit gets `false` rather than an exception.
 */
static JSValue exec_write(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv, int magic,
                          JSValue *data)
{
    int32_t  id = 0;
    ExecJob *job;
    GError  *err = NULL;
    gsize    written = 0;

    (void)this_val; (void)magic;
    JS_ToInt32(ctx, &id, data[0]);

    job = NULL;
    for (GList *l = exec_jobs; l; l = l->next) {
        ExecJob *j = l->data;
        if (j->id == id) {
            job = j;
            break;
        }
    }
    if (!job || !job->in || job->reaped)
        return JS_FALSE;

    const char *text = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!text)
        return JS_ThrowTypeError(ctx, "Write(text) needs text");

    char *line = g_str_has_suffix(text, "\n") ? g_strdup(text)
                                              : g_strdup_printf("%s\n", text);
    JS_FreeCString(ctx, text);

    gboolean ok = g_output_stream_write_all(job->in, line, strlen(line),
                                            &written, NULL, &err);
    /* Flushed, because the other side is blocked on a read: a line sitting in a
     * buffer here is a program waiting there. */
    if (ok)
        g_output_stream_flush(job->in, NULL, NULL);
    g_free(line);
    g_clear_error(&err);

    return ok ? JS_TRUE : JS_FALSE;
}

static JSValue exec_signal(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv, int magic,
                           JSValue *data)
{
    int32_t id = 0;
    JS_ToInt32(ctx, &id, data[0]);

    for (GList *l = exec_jobs; l; l = l->next) {
        ExecJob *job = l->data;

        if (job->id != id)
            continue;
        /*
         * Reaped and not yet freed is a real state -- it is where the exit
         * callback runs -- and signalling there would send SIGTERM to a pid the
         * system has already handed back, which is somebody else's process by
         * then.  Nothing to stop, so: false.
         */
        if (job->reaped || job->pid <= 0)
            return JS_FALSE;

        /* `Stop` asks and `Kill` makes -- where the platform has both.  On
         * Windows there is one ending, and `exec_signal_group` is where that
         * sentence lives. */
        exec_signal_group(job->proc, job->pid, magic != 0);
        return JS_TRUE;
    }
    return JS_FALSE;
}

/*
 * The argument list, as a NULL-terminated vector -- or NULL with an exception
 * pending, so a caller can hand the failure straight back.
 *
 * `who` names the call in the complaint: the two spellings of Exec share this,
 * and a message that says "Exec" for a failed `Exec.Wait` sends whoever reads it
 * to the wrong line.
 */
static GPtrArray *exec_build_argv(JSContext *ctx, JSValueConst list,
                                  const char *who)
{
    JSValue  lenv = JS_GetPropertyStr(ctx, list, "length");
    uint32_t n    = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    if (n == 0) {
        JS_ThrowTypeError(ctx, "%s: argv is empty", who);
        return NULL;
    }

    GPtrArray *args = g_ptr_array_new_with_free_func(g_free);
    for (uint32_t i = 0; i < n; i++) {
        JSValue     e = JS_GetPropertyUint32(ctx, list, i);
        const char *s = JS_ToCString(ctx, e);
        JS_FreeValue(ctx, e);
        if (!s) {
            g_ptr_array_unref(args);
            return NULL;
        }
        g_ptr_array_add(args, g_strdup(s));
        JS_FreeCString(ctx, s);
    }
    g_ptr_array_add(args, NULL);
    return args;
}

/*
 * The launcher both spellings of Exec start their child with: one pipe for
 * stdout, stderr either merged into it or on a pipe of its own, and a process
 * group of the child's own.
 *
 * The group is the same in both, and for `Exec.Wait` that took a second look.
 * A blocked caller cannot answer a Ctrl-C, so leaving the child in the caller's
 * group is tempting: the interrupt would then reach both, and the child would
 * not be orphaned by an escape hatch.  But it breaks the guard, and breaks it
 * into a hang.  A timeout that can only signal the direct child leaves a
 * wrapper's grandchild holding the write end of the pipe, so the read never sees
 * EOF and the wait that was supposed to end never does.  A guard that does not
 * guarantee an ending is worth less than an interrupt, so the group wins -- and
 * the honest consequence is that a `Wait` with no `Timeout` has no ending the
 * caller controls.
 */
/*
 * The third stream, when the caller asked for one.
 *
 * A pipe whose writing end becomes descriptor 3 in the child, and whose reading
 * end this side keeps. Three, because 0, 1 and 2 are spoken for and a protocol
 * cannot share stdout with what the program prints: marking its lines with a
 * prefix would mean a program that prints the prefix breaks its own tooling,
 * silently. `-1` when no `Control` was given, which is every caller but one.
 *
 * **Windows refuses it rather than ignoring it** (`-2`, exception pending).
 * A callback that is accepted and never called is the silent failure this
 * whole runtime is written against, and there is no version of it to offer
 * there: `g_subprocess_launcher_take_fd` is Unix-only, and so is
 * `GUnixInputStream`. The debugger is the one caller in the tree, and it is
 * Linux's for now.
 */
static int exec_control_fd(JSContext *ctx, JSValueConst opts,
                           GSubprocessLauncher *launcher)
{
    JSValue cb;
#ifndef G_OS_WIN32
    int     ends[2];
#endif

    if (JS_IsUndefined(opts))
        return -1;

    cb = JS_GetPropertyStr(ctx, opts, "Control");
    if (!JS_IsFunction(ctx, cb)) {
        JS_FreeValue(ctx, cb);
        return -1;
    }
    JS_FreeValue(ctx, cb);

#ifdef G_OS_WIN32
    JS_ThrowInternalError(ctx,
        "Exec: Control needs a descriptor a child inherits, which this platform has not got");
    return -2;
#else
    if (pipe(ends) != 0)
        return -1;

    /* The launcher takes the writing end and closes it here after the spawn,
       which is what makes the child's descriptor 3 the only one left open on
       it -- and so what makes the reading end see an end of file when the
       child goes away. */
    g_subprocess_launcher_take_fd(launcher, ends[1], 3);
    return ends[0];
#endif
}

static GSubprocessLauncher *exec_launcher(JSContext *ctx, JSValueConst opts,
                                          bool split)
{
    /*
     * **stdin is always a pipe.** Without it a child inherits whatever the
     * parent had -- the terminal the IDE was started from -- which is a thing
     * no `Exec` caller wants and the reason `Write` had nowhere to write. A
     * child that reads stdin and is written nothing waits, which is what it did
     * before this too.
     */
    GSubprocessLauncher *launcher = g_subprocess_launcher_new(
        G_SUBPROCESS_FLAGS_STDOUT_PIPE | G_SUBPROCESS_FLAGS_STDIN_PIPE |
        (split ? G_SUBPROCESS_FLAGS_STDERR_PIPE : G_SUBPROCESS_FLAGS_STDERR_MERGE));

#ifndef G_OS_WIN32
    g_subprocess_launcher_set_child_setup(launcher, exec_child_setup, NULL, NULL);
#endif
    if (!JS_IsUndefined(opts))
        exec_apply_options(ctx, opts, launcher);

    return launcher;
}


static JSValue sys_exec(JSContext *ctx, JSValueConst this_val,
                        int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsArray(argv[0]))
        return JS_ThrowTypeError(ctx,
            "Exec(argv, [options], onLine, onExit): argv must be an array");

    /* The options are optional and sit where a callback used to, so the two are
     * told apart by what they are: a function is a callback, an object is the
     * options.  Both spellings stay right, and neither needs a placeholder. */
    JSValueConst opts = JS_UNDEFINED;
    int          cb   = 1;
    if (argc > 1 && JS_IsObject(argv[1]) && !JS_IsFunction(ctx, argv[1])
        && !JS_IsArray(argv[1])) {
        opts = argv[1];
        cb   = 2;
    }

    GPtrArray *args = exec_build_argv(ctx, argv[0], "Exec");
    if (!args)
        return JS_EXCEPTION;

    bool split = exec_wants_split(ctx, opts);

    GSubprocessLauncher *launcher = exec_launcher(ctx, opts, split);
    int                  ctl_fd  = exec_control_fd(ctx, opts, launcher);

    /* Refused, and the refusal is the answer: see exec_control_fd. */
    if (ctl_fd == -2) {
        g_object_unref(launcher);
        g_ptr_array_unref(args);
        return JS_EXCEPTION;
    }

    GError      *err  = NULL;
    GSubprocess *proc = g_subprocess_launcher_spawnv(
        launcher, (const gchar * const *)args->pdata, &err);
    g_object_unref(launcher);
    g_ptr_array_unref(args);

    if (!proc) {
        JSValue e = JS_ThrowInternalError(ctx, "Exec failed: %s",
                                          err ? err->message : "unknown error");
        g_clear_error(&err);
        if (ctl_fd >= 0)
            close(ctl_fd);
        return e;
    }

    /*
     * The pid, asked for **once and at once**.
     *
     * GSubprocess reaps its child on GLib's own worker thread, so the identifier
     * it hands out becomes NULL the moment the child is gone -- which for
     * something like `/bin/true` can be between two lines of this function. Read
     * later, or read twice, it is a NULL dereference that shows up only under
     * load: AddressSanitizer crashed on it in the widgets suite, and a plain
     * build had the same race waiting.
     *
     * Zero when it was already too late to ask, and `Stop`/`Kill` answer false
     * for such a job -- there was never anything left to signal.
     */
    const char *ident = g_subprocess_get_identifier(proc);
    pid_t       pid   = ident ? (pid_t)g_ascii_strtoll(ident, NULL, 10) : 0;

    ExecJob *job = g_new0(ExecJob, 1);
    job->ctx     = ctx;
    job->proc    = proc;
    job->id      = exec_next_id++;
    job->pid     = pid;
    job->cancel  = g_cancellable_new();
    job->on_line = argc > cb     ? JS_DupValue(ctx, argv[cb])     : JS_UNDEFINED;
    job->on_exit = argc > cb + 1 ? JS_DupValue(ctx, argv[cb + 1]) : JS_UNDEFINED;
    job->out     = g_data_input_stream_new(g_subprocess_get_stdout_pipe(proc));
    job->err     = split ? g_data_input_stream_new(g_subprocess_get_stderr_pipe(proc))
                         : NULL;
    job->err_eof = !split;   /* no second pipe is a second pipe already drained */
    job->in      = g_subprocess_get_stdin_pipe(proc);
    job->on_control = JS_UNDEFINED;
#ifndef G_OS_WIN32
    if (ctl_fd >= 0) {
        job->control    = g_data_input_stream_new(
            g_unix_input_stream_new(ctl_fd, TRUE));
        job->on_control = JS_GetPropertyStr(ctx, opts, "Control");
    }
#endif

    job->kill_after = exec_millis(ctx, opts, "KillAfter", EXEC_KILL_AFTER);

    exec_jobs = g_list_prepend(exec_jobs, job);

    exec_read_next(job, job->out);
    if (job->err)
        exec_read_next(job, job->err);
    if (job->control)
        exec_read_next(job, job->control);
    g_subprocess_wait_async(proc, job->cancel, on_exec_done, job);

    /*
     * The handle: what the child is, and the two ways to end it.  It used to be
     * the pid as a string, which was a number to print and nothing to do -- and
     * a string for a number besides, where `Environment.ProcessId` next to it is
     * an integer.
     *
     * `Running` and `ExitCode` are written on it rather than asked of the job,
     * because the question outlives the job: the ordinary place to read an exit
     * code is after the child is gone, and by then there is nothing left to ask.
     */
    JSValue idv    = JS_NewInt32(ctx, job->id);
    JSValue handle = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, handle, "ProcessId", JS_NewInt32(ctx, (int32_t)pid));
    JS_SetPropertyStr(ctx, handle, "Running", JS_TRUE);
    JS_SetPropertyStr(ctx, handle, "ExitCode", JS_NULL);
    /* Always present, so a caller reads a boolean rather than telling `false`
     * from a key that is not there. */
    JS_SetPropertyStr(ctx, handle, "TimedOut", JS_FALSE);
    JS_SetPropertyStr(ctx, handle, "Stop",
                      JS_NewCFunctionData(ctx, exec_signal, 0, 0, 1, &idv));
    JS_SetPropertyStr(ctx, handle, "Kill",
                      JS_NewCFunctionData(ctx, exec_signal, 0, 1, 1, &idv));
    JS_SetPropertyStr(ctx, handle, "Write",
                      JS_NewCFunctionData(ctx, exec_write, 1, 0, 1, &idv));
    JS_FreeValue(ctx, idv);

    job->handle = JS_DupValue(ctx, handle);

    /*
     * Armed last, because it writes on the handle: a `Timeout` shorter than the
     * spawn itself would otherwise fire against a handle that does not exist
     * yet.  A child already reaped needs no guard -- `/bin/true` can be gone by
     * this line.
     */
    unsigned timeout = exec_millis(ctx, opts, "Timeout", 0);
    if (timeout > 0 && !job->reaped)
        job->guard = g_timeout_add(timeout, on_exec_guard, job);

    return handle;
}

/*
 * What the blocking wait is waiting for: communicate's answer, or its failure.
 *
 * **Bytes and not `_utf8`**, which is a change and the reason for it is a NUL.
 * The utf8 spelling hands back a C string, so everything past the first NUL is
 * gone -- and a NUL is what the tools that have to be unambiguous separate
 * their answers with: `git status -z`, `find -print0`, `xargs -0`. A file name
 * with a space in it was readable and one in a list was not, silently, which is
 * the worst shape a bug can have.
 */
typedef struct {
    bool    done;
    GBytes *out;
    GBytes *errs;
    GError *err;
} ExecWaitState;

static void on_exec_wait_done(GObject *src, GAsyncResult *res, gpointer data)
{
    ExecWaitState *w = data;

    g_subprocess_communicate_finish(G_SUBPROCESS(src), res,
                                    &w->out, &w->errs, &w->err);
    w->done = true;
}

/* A captured stream as a string, NULs and all. */
static JSValue exec_captured(JSContext *ctx, GBytes *bytes)
{
    gsize       len  = 0;
    const char *data = bytes ? g_bytes_get_data(bytes, &len) : NULL;

    return JS_NewStringLen(ctx, data ? data : "", data ? len : 0);
}

/* A deadline on a private context, as a flag going true.  No JS runs from here
 * -- the wait itself decides what to do about it -- which is what keeps this
 * loop from being an event loop. */
static gboolean on_exec_wait_late(gpointer data)
{
    *(bool *)data = true;
    return G_SOURCE_REMOVE;
}

static GSource *exec_wait_guard(GMainContext *where, unsigned ms, bool *flag)
{
    if (ms == 0)
        return NULL;   /* no deadline asked for, or none left to wait */

    GSource *src = g_timeout_source_new(ms);
    g_source_set_callback(src, on_exec_wait_late, flag, NULL);
    g_source_attach(src, where);
    return src;
}

static void exec_wait_guard_free(GSource *src)
{
    if (!src)
        return;
    g_source_destroy(src);
    g_source_unref(src);
}

/*
 * Exec.Wait(argv, [options]) -- the child, run to the end, as a record.
 *
 * The other spelling of the same call, for the case the asynchronous one makes
 * worse rather than better: a tool that runs a command it knows ends, looks at
 * what happened, and goes on.  `Translations.mergeAll` runs msgmerge over every
 * catalogue in turn, and with only a callback to work with that has to be
 * written as a recursion carrying its own index -- where this is a `for` loop
 * with nothing new in it.  Gambas spells it `EXEC ... WAIT`; .NET calls it
 * `WaitForExit`.  See docs/async-plan.md for why the language stops here rather
 * than growing a word for *do this, then that*.
 *
 * **It freezes the window**, and that is the honest half of the bargain: nothing
 * paints and nothing responds until the child exits.  It is also what makes it
 * safe, unlike the DoEvents this resembles -- there is no nested main loop, so
 * no handler runs inside the wait and nothing can close the form the caller is
 * standing in.  A frozen window is visible; a live window that is lying is where
 * lifetime crashes come from.
 *
 * And **there is no timeout**: with no loop running there is nowhere to arm a
 * timer that would kill the child, so a command that never ends hangs the
 * program.  Exactly as it would in a shell script.  For anything long, of
 * unknown length, or that has to show progress, the callback spelling is the one
 * that is right.
 *
 * Nothing here outlives the call: no job registered, no JSValue held across an
 * async boundary, nothing for bta_sys_cleanup() to free.  Which is the whole of
 * why it is short.
 */
static JSValue sys_exec_wait(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsArray(argv[0]))
        return JS_ThrowTypeError(ctx,
            "Exec.Wait(argv, [options]): argv must be an array");

    /* No callbacks to tell apart here, so the options are simply the second
     * argument -- and an array in that position is a mistake worth naming, since
     * it is what somebody reaching for a second command would write. */
    JSValueConst opts = JS_UNDEFINED;
    if (argc > 1 && JS_IsObject(argv[1]) && !JS_IsArray(argv[1])
        && !JS_IsFunction(ctx, argv[1])) {
        opts = argv[1];
    } else if (argc > 1 && !JS_IsUndefined(argv[1]) && !JS_IsNull(argv[1])) {
        return JS_ThrowTypeError(ctx,
            "Exec.Wait(argv, [options]): the second argument is the options "
            "object -- Wait takes no callbacks, it answers with a record");
    }

    GPtrArray *args = exec_build_argv(ctx, argv[0], "Exec.Wait");
    if (!args)
        return JS_EXCEPTION;

    bool     split      = exec_wants_split(ctx, opts);
    unsigned timeout    = exec_millis(ctx, opts, "Timeout", 0);
    unsigned kill_after = exec_millis(ctx, opts, "KillAfter", EXEC_KILL_AFTER);

    /*
     * A main context of this call's own, and it is what lets a blocking call
     * have a timeout at all.
     *
     * The sources GTK waits on live on the **default** context, and so do our
     * own `Timer`s and every pending asynchronous `Exec`.  Iterating a private
     * one runs the guard below and nothing else: no handler of the application's
     * can fire inside the wait, which is the whole difference between this and
     * DoEvents.  The window stays exactly as frozen as it was before there was a
     * timeout.
     *
     * **Pushed before the spawn**, which is load-bearing: GSubprocess takes the
     * thread-default context when it is constructed, and a child watch left on
     * the default context would never be dispatched by the loop below -- the
     * wait would hang with the child long finished.
     */
    GMainContext *priv = g_main_context_new();
    g_main_context_push_thread_default(priv);

    GSubprocessLauncher *launcher = exec_launcher(ctx, opts, split);

    GError      *err  = NULL;
    GSubprocess *proc = g_subprocess_launcher_spawnv(
        launcher, (const gchar * const *)args->pdata, &err);
    g_object_unref(launcher);
    g_ptr_array_unref(args);

    if (!proc) {
        JSValue e = JS_ThrowInternalError(ctx, "Exec.Wait failed: %s",
                                          err ? err->message : "unknown error");
        g_clear_error(&err);
        g_main_context_pop_thread_default(priv);
        g_main_context_unref(priv);
        return e;
    }

    /* Asked for once and at once, for the reason the callback spelling explains:
     * GSubprocess reaps on GLib's worker thread, so the identifier is gone the
     * moment the child is. */
    const char *ident = g_subprocess_get_identifier(proc);
    pid_t       pid   = ident ? (pid_t)g_ascii_strtoll(ident, NULL, 10) : 0;

    /*
     * communicate writes nothing to stdin, drains both pipes and waits.
     * Draining is not optional: a child that fills a pipe nobody reads blocks
     * forever, which is the deadlock a hand-written wait-then-read walks into.
     * The async spelling of it, because a timeout needs a loop to fire on.
     */
    ExecWaitState w = { false, NULL, NULL, NULL };
    /*
     * An **empty** stdin and not none.
     *
     * The utf8 spelling takes a NULL there; the bytes one asserts on it when the
     * child has a stdin pipe -- which every child has had since `Write` was
     * added. Empty means the same thing it always meant: nothing is written, and
     * the pipe is closed, so a child that reads stdin sees the end of it rather
     * than waiting for a `Wait` that is already blocked on the child.
     */
    GBytes *nothing = g_bytes_new_static("", 0);

    g_subprocess_communicate_async(proc, nothing, NULL, on_exec_wait_done, &w);
    g_bytes_unref(nothing);

    bool     late  = false;
    GSource *guard = exec_wait_guard(priv, timeout, &late);

    while (!w.done && !late)
        g_main_context_iteration(priv, TRUE);

    /* The two stages, the same ones the callback spelling arms on timers: asked
     * to end, then made to.  To the group, since the child leads one. */
    if (late) {
        exec_signal_group(proc, pid, false);

        bool     harder = kill_after == 0;
        GSource *force  = exec_wait_guard(priv, kill_after, &harder);

        while (!w.done && !harder)
            g_main_context_iteration(priv, TRUE);

        if (!w.done)
            exec_signal_group(proc, pid, true);
        while (!w.done)
            g_main_context_iteration(priv, TRUE);

        exec_wait_guard_free(force);
    }
    exec_wait_guard_free(guard);

    g_main_context_pop_thread_default(priv);
    g_main_context_unref(priv);

    GBytes *out = w.out, *errs = w.errs;

    if (w.err) {
        JSValue e = JS_ThrowInternalError(ctx, "Exec.Wait failed: %s",
                                          w.err->message);
        g_clear_error(&w.err);
        g_clear_pointer(&out, g_bytes_unref);
        g_clear_pointer(&errs, g_bytes_unref);
        g_object_unref(proc);
        return e;
    }

    /* -1 for a child stopped by a signal, as the callback spelling reports it:
     * it did not exit, so it has no status of its own, and the difference
     * between "failed" and "was stopped" is worth keeping.  A child the guard
     * ended is in exactly that state, which is why `TimedOut` is a separate
     * answer rather than a status nobody can tell apart. */
    int status = g_subprocess_get_if_exited(proc)
                     ? g_subprocess_get_exit_status(proc) : -1;

    JSValue result = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, result, "ExitCode", JS_NewInt32(ctx, status));
    JS_SetPropertyStr(ctx, result, "Output", exec_captured(ctx, out));
    JS_SetPropertyStr(ctx, result, "TimedOut", JS_NewBool(ctx, late));

    /*
     * `Errors` only when the two streams were asked for apart.  Merged, there is
     * no second stream to report and an empty string would read as *it wrote
     * nothing to stderr* -- which is a different claim.  The same reason the
     * callback spelling passes `undefined` rather than `"out"` for the origin of
     * a line when the streams are merged.
     */
    if (split)
        JS_SetPropertyStr(ctx, result, "Errors", exec_captured(ctx, errs));

    g_clear_pointer(&out, g_bytes_unref);
    g_clear_pointer(&errs, g_bytes_unref);
    g_object_unref(proc);
    return result;
}


/* ---------------------------------------------------------------- timers */

typedef struct {
    JSContext *ctx;
    JSValue    fn;
    guint      id;
    bool       repeat;
} TimerJob;

static GHashTable *timers;   /* guint id -> TimerJob*, owned by the GSource */

static void timer_destroy(gpointer data)
{
    TimerJob *t = data;

    if (timers)
        g_hash_table_remove(timers, GUINT_TO_POINTER(t->id));
    JS_FreeValue(t->ctx, t->fn);
    g_free(t);
}

static gboolean on_timer(gpointer data)
{
    TimerJob *t = data;

    JSValue r = JS_Call(t->ctx, t->fn, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(r))
        bta_dump_error(t->ctx);
    JS_FreeValue(t->ctx, r);
    bta_drain_jobs(JS_GetRuntime(t->ctx));

    return t->repeat ? G_SOURCE_CONTINUE : G_SOURCE_REMOVE;
}

static JSValue sys_set_timer(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv, int magic)
{
    if (argc < 1 || !JS_IsFunction(ctx, argv[0]))
        return JS_ThrowTypeError(ctx, "a function is required");

    int32_t ms = 0;
    if (argc > 1 && JS_ToInt32(ctx, &ms, argv[1]))
        return JS_EXCEPTION;
    if (ms < 0)
        ms = 0;

    TimerJob *t = g_new0(TimerJob, 1);
    t->ctx    = ctx;
    t->fn     = JS_DupValue(ctx, argv[0]);
    t->repeat = magic != 0;

    /* The GSource owns the job; timer_destroy releases the callback whether it
     * ends by itself, by clearTimeout, or at teardown. */
    t->id = g_timeout_add_full(G_PRIORITY_DEFAULT, ms, on_timer, t, timer_destroy);

    if (!timers)
        timers = g_hash_table_new(NULL, NULL);
    g_hash_table_insert(timers, GUINT_TO_POINTER(t->id), t);

    return JS_NewInt32(ctx, (int32_t)t->id);
}

static JSValue sys_clear_timer(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    int32_t id;
    if (argc < 1 || JS_ToInt32(ctx, &id, argv[0]))
        return JS_UNDEFINED;

    if (timers && g_hash_table_contains(timers, GUINT_TO_POINTER(id)))
        g_source_remove((guint)id);   /* fires timer_destroy */
    return JS_UNDEFINED;
}

/* ----------------------------------------------------------- Environment */

/*
 * The context a program was started in: its environment, its directory, and the
 * few facts about the machine that a program acts on rather than displays.
 *
 * One object and not a member here and a member there, because they are one
 * subject and they are asked together: a runner reads `DISPLAY`, decides on
 * `HasDisplay`, names a scratch directory after `ProcessId` and builds with
 * `ProcessorCount`.  Those were four different shell builtins and are one class.
 *
 * What is deliberately *not* here: the command line, which is `Application.Arguments`
 * because it belongs to the application and not to the system, and quitting,
 * which is `Application.Quit` for the same reason.
 */
static JSValue env_get(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv)
{
    const char *name = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!name)
        return JS_ThrowTypeError(ctx, "Environment.Get(name) expects a name");

    const char *value = g_getenv(name);
    JS_FreeCString(ctx, name);
    return value ? JS_NewString(ctx, value) : JS_NULL;
}

/*
 * Set for this process *and everything it starts afterwards*, which is what
 * `export` means in the shell and the only reason to change one's own.
 *
 * `null` removes.  A single child's environment is `Exec`'s `Env`, and that is
 * the one to reach for first: it says what it changes and for whom, where this
 * changes it for everything started from here on.
 */
static JSValue env_set(JSContext *ctx, JSValueConst this_val,
                       int argc, JSValueConst *argv)
{
    const char *name = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!name)
        return JS_ThrowTypeError(ctx, "Environment.Set(name, value) expects a name");

    if (argc < 2 || JS_IsNull(argv[1]) || JS_IsUndefined(argv[1])) {
        g_unsetenv(name);
    } else {
        const char *value = JS_ToCString(ctx, argv[1]);
        if (!value) {
            JS_FreeCString(ctx, name);
            return JS_EXCEPTION;
        }
        g_setenv(name, value, TRUE);
        JS_FreeCString(ctx, value);
    }
    JS_FreeCString(ctx, name);
    return JS_UNDEFINED;
}

/* Every name at once, as an ordinary object: what a program reports when it says
 * where it ran, and a fresh copy each time because `Set` moves underneath it. */
static JSValue env_variables(JSContext *ctx, JSValueConst this_val)
{
    char  **all = g_get_environ();
    JSValue out = JS_NewObject(ctx);

    for (int i = 0; all && all[i]; i++) {
        char *eq = strchr(all[i], '=');
        if (!eq)
            continue;
        *eq = '\0';
        JS_SetPropertyStr(ctx, out, all[i], JS_NewString(ctx, eq + 1));
    }
    g_strfreev(all);
    return out;
}

static JSValue env_cwd_get(JSContext *ctx, JSValueConst this_val)
{
    char   *cwd = g_get_current_dir();
    JSValue v   = JS_NewString(ctx, cwd);
    g_free(cwd);
    return v;
}

static JSValue env_cwd_set(JSContext *ctx, JSValueConst this_val, JSValueConst val)
{
    const char *path = JS_ToCString(ctx, val);
    if (!path)
        return JS_EXCEPTION;

    /* Refused rather than ignored: a relative path resolved against a directory
     * that was never entered is the kind of wrong that shows up three calls
     * later, in whatever tried to read a file. */
    int rc = g_chdir(path);
    if (rc != 0) {
        JSValue e = JS_ThrowInternalError(ctx, "cannot enter %s: %s",
                                          path, g_strerror(errno));
        JS_FreeCString(ctx, path);
        return e;
    }
    JS_FreeCString(ctx, path);
    return JS_UNDEFINED;
}

/*
 * Whether this environment offers a display -- and *not* whether this process
 * has opened one.
 *
 * That is the question a program asks before starting something that needs a
 * screen, which is the only reason to ask it: a console project has no display
 * of its own by construction, yet the child it is about to run may have a
 * perfectly good one.  The two variables are the two ways a Linux desktop says
 * so, and a runner that finds neither is the runner that reaches for Xvfb.
 */
static JSValue env_has_display(JSContext *ctx, JSValueConst this_val)
{
#ifdef G_OS_WIN32
    /* A Windows session has a display and no variable says so: the two the
     * Linux desktop publishes are about *which* one, and a runner asking this
     * question must not go looking for Xvfb. */
    return JS_TRUE;
#else
    const char *x11     = g_getenv("DISPLAY");
    const char *wayland = g_getenv("WAYLAND_DISPLAY");

    return JS_NewBool(ctx, (x11 && *x11) || (wayland && *wayland));
#endif
}

/*
 * Enumerable, unlike the defaults these macros carry, and it is not decoration:
 * `Object.keys(Environment)` is what the IDE's completion asks -- a table of
 * *names* and not of members, so a global that gains one in C gains it there
 * with nothing changed.  A member nobody can enumerate is a member the IDE
 * cannot offer.
 */
static const JSCFunctionListEntry env_props[] = {
    JS_CFUNC_DEF2("Get", 1, env_get, JS_PROP_C_W_E),
    JS_CFUNC_DEF2("Set", 2, env_set, JS_PROP_C_W_E),
    JS_CGETSET_DEF2("Variables", env_variables, NULL,
                    JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
    JS_CGETSET_DEF2("CurrentDirectory", env_cwd_get, env_cwd_set,
                    JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
    JS_CGETSET_DEF2("HasDisplay", env_has_display, NULL,
                    JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE),
};

/* ---------------------------------------------------------------- Screen
 *
 * How big the desktop is, and how many pieces it is in.
 *
 * A program that wants to open a window the height of the screen, adapt to a
 * laptop panel, or put a palette on the second monitor had nothing to ask:
 * `Form.Bounds()` answers for the window and `Application` for the desktop's
 * decorations, and neither knows what it is sitting on.
 *
 * **The numbers are in the same pixels a form's `Width` is** -- logical ones,
 * with the scale factor answered separately -- so `Screen.Width / 2` is a window
 * width and not a surprise on a HiDPI panel.
 */

/* The monitors this display has, or NULL where there is no display: a console
 * project (`main`) never opened one, and everything below answers nothing rather
 * than refusing -- "how big is the screen" has an honest answer of zero when
 * there is no screen, and a program asking is usually deciding a default. */
static GListModel *screen_monitors(void)
{
    GdkDisplay *display = gdk_display_get_default();

    return display ? gdk_display_get_monitors(display) : NULL;
}

/*
 * The monitor a `Screen.Width` means.
 *
 * **GTK4 has no primary monitor** -- `gdk_screen_get_primary_monitor` went with
 * GTK3, because Wayland does not answer it -- so the one that matters is the one
 * the user is looking at, which is the one the application's active window is
 * on. With no window yet (`Form_Open`, before anything is shown) it is the first
 * the display lists, which is the only other answer there is.
 */
static GdkMonitor *screen_current(void)
{
    GdkDisplay *display = gdk_display_get_default();
    if (!display)
        return NULL;

    BtaApp *app = bta_current_app();
    GtkWindow *win = app && app->gapp ? gtk_application_get_active_window(app->gapp) : NULL;

    if (win && gtk_widget_get_realized(GTK_WIDGET(win))) {
        GdkSurface *surface = gtk_native_get_surface(GTK_NATIVE(win));
        GdkMonitor *at      = surface ? gdk_display_get_monitor_at_surface(display, surface)
                                      : NULL;
        if (at)
            return at;
    }

    GListModel *monitors = gdk_display_get_monitors(display);
    if (!monitors || g_list_model_get_n_items(monitors) == 0)
        return NULL;

    /* The list owns it and `get_item` hands over a reference; the display keeps
     * the monitor alive either way, so it goes straight back. */
    GdkMonitor *first = g_list_model_get_item(monitors, 0);
    if (first)
        g_object_unref(first);
    return first;
}

enum { SCREEN_WIDTH, SCREEN_HEIGHT, SCREEN_SCALE };

static JSValue screen_geometry(JSContext *ctx, JSValueConst this_val, int magic)
{
    GdkMonitor *m = screen_current();
    if (!m)
        return JS_NewInt32(ctx, magic == SCREEN_SCALE ? 1 : 0);

    if (magic == SCREEN_SCALE)
        return JS_NewInt32(ctx, gdk_monitor_get_scale_factor(m));

    GdkRectangle r;
    gdk_monitor_get_geometry(m, &r);
    return JS_NewInt32(ctx, magic == SCREEN_WIDTH ? r.width : r.height);
}

/*
 * Every monitor, in the display's own order, each `{ X, Y, Width, Height,
 * Scale, Name }`.
 *
 * `X`/`Y` are where this monitor sits in the desktop's coordinates, which is
 * what makes two of them addressable at all: a window on the second screen is
 * one placed past the first one's width. `Name` is the connector (`HDMI-1`,
 * `eDP-1`) -- a key to remember a choice by, not prose to show.
 */
static JSValue screen_list(JSContext *ctx, JSValueConst this_val,
                           int argc, JSValueConst *argv)
{
    JSValue     out      = JS_NewArray(ctx);
    GListModel *monitors = screen_monitors();
    guint       n        = monitors ? g_list_model_get_n_items(monitors) : 0;

    for (guint i = 0; i < n; i++) {
        GdkMonitor *m = g_list_model_get_item(monitors, i);
        if (!m)
            continue;

        GdkRectangle r;
        gdk_monitor_get_geometry(m, &r);

        const char *name = gdk_monitor_get_connector(m);
        JSValue     one  = JS_NewObject(ctx);

        JS_SetPropertyStr(ctx, one, "X",      JS_NewInt32(ctx, r.x));
        JS_SetPropertyStr(ctx, one, "Y",      JS_NewInt32(ctx, r.y));
        JS_SetPropertyStr(ctx, one, "Width",  JS_NewInt32(ctx, r.width));
        JS_SetPropertyStr(ctx, one, "Height", JS_NewInt32(ctx, r.height));
        JS_SetPropertyStr(ctx, one, "Scale",
                          JS_NewInt32(ctx, gdk_monitor_get_scale_factor(m)));
        JS_SetPropertyStr(ctx, one, "Name",   JS_NewString(ctx, name ? name : ""));

        JS_SetPropertyUint32(ctx, out, i, one);
        g_object_unref(m);
    }
    return out;
}

static JSValue screen_get_width(JSContext *ctx, JSValueConst t)
{ return screen_geometry(ctx, t, SCREEN_WIDTH); }
static JSValue screen_get_height(JSContext *ctx, JSValueConst t)
{ return screen_geometry(ctx, t, SCREEN_HEIGHT); }
static JSValue screen_get_scale(JSContext *ctx, JSValueConst t)
{ return screen_geometry(ctx, t, SCREEN_SCALE); }

static const JSCFunctionListEntry screen_props[] = {
    JS_CGETSET_DEF("Width",  screen_get_width,  NULL),
    JS_CGETSET_DEF("Height", screen_get_height, NULL),
    JS_CGETSET_DEF("Scale",  screen_get_scale,  NULL),
    JS_CFUNC_DEF("Monitors", 0, screen_list),
};

/* ------------------------------------------------------------- Clipboard */

/*
 * Copying is immediate; pasting is not, and cannot be: the clipboard belongs to
 * whoever owns the selection, and its contents arrive when that application
 * answers.  So Copy is a call and Paste takes a callback, like Dialog -- the
 * asymmetry is the platform's, not a choice.
 */
typedef struct {
    JSContext *ctx;
    JSValue    cb;
} PasteJob;

static GList *paste_jobs;   /* PasteJob*, reads in flight */

static void paste_job_free(PasteJob *job)
{
    paste_jobs = g_list_remove(paste_jobs, job);
    JS_FreeValue(job->ctx, job->cb);
    g_free(job);
}

static GdkClipboard *clipboard_of(void)
{
    GdkDisplay *display = gdk_display_get_default();
    return display ? gdk_display_get_clipboard(display) : NULL;
}

static JSValue sys_clip_copy(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    const char *text = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!text)
        return JS_ThrowTypeError(ctx, "Clipboard.Copy(text) expects a string");

    GdkClipboard *clip = clipboard_of();
    if (clip)
        gdk_clipboard_set_text(clip, text);

    JS_FreeCString(ctx, text);
    return JS_UNDEFINED;
}

static void on_paste(GObject *src, GAsyncResult *res, gpointer user_data)
{
    PasteJob *job  = user_data;
    GError   *err  = NULL;
    char     *text = gdk_clipboard_read_text_finish(GDK_CLIPBOARD(src), res, &err);

    if (g_error_matches(err, G_IO_ERROR, G_IO_ERROR_CANCELLED)) {
        g_clear_error(&err);
        g_free(text);
        return;                      /* teardown already freed the job */
    }
    g_clear_error(&err);

    /* Nothing to paste is an empty string, not an error: a clipboard holding an
     * image is as ordinary as an empty one. */
    JSValue arg = JS_NewString(job->ctx, text ? text : "");
    JSValue r   = JS_Call(job->ctx, job->cb, JS_UNDEFINED, 1, &arg);

    if (JS_IsException(r))
        bta_dump_error(job->ctx);
    JS_FreeValue(job->ctx, r);
    JS_FreeValue(job->ctx, arg);
    bta_drain_jobs(JS_GetRuntime(job->ctx));

    g_free(text);
    paste_job_free(job);
}

static JSValue sys_clip_paste(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsFunction(ctx, argv[0]))
        return JS_ThrowTypeError(ctx,
            "Clipboard.Paste(cb) needs a callback: reading is asynchronous");

    GdkClipboard *clip = clipboard_of();
    if (!clip)
        return JS_ThrowInternalError(ctx, "no display, no clipboard");

    PasteJob *job = g_new0(PasteJob, 1);
    job->ctx = ctx;
    job->cb  = JS_DupValue(ctx, argv[0]);
    paste_jobs = g_list_prepend(paste_jobs, job);

    gdk_clipboard_read_text_async(clip, NULL, on_paste, job);
    return JS_UNDEFINED;
}

/* ---------------------------------------------------------------- Dialog */

/*
 * GTK4 file dialogs are asynchronous, so these take a callback rather than
 * returning a path.  The callback is a strong reference held from C; it is
 * released on every path out, including the user cancelling.
 */
typedef struct {
    JSContext *ctx;
    JSValue    cb;
} DialogJob;

enum { DLG_FOLDER, DLG_FILE, DLG_SAVE };

#define DIALOG_MODE_KEY "bta-dialog-mode"


static GList *dialog_jobs;

static void dialog_job_finish(DialogJob *job, char *path)
{
    dialog_jobs = g_list_remove(dialog_jobs, job);

    if (path && JS_IsFunction(job->ctx, job->cb)) {
        JSValue arg = JS_NewString(job->ctx, path);
        JSValue r   = JS_Call(job->ctx, job->cb, JS_UNDEFINED, 1, &arg);
        if (JS_IsException(r))
            bta_dump_error(job->ctx);
        JS_FreeValue(job->ctx, r);
        JS_FreeValue(job->ctx, arg);
        bta_drain_jobs(JS_GetRuntime(job->ctx));
    }
    g_free(path);
    JS_FreeValue(job->ctx, job->cb);
    g_free(job);
}

static void on_dialog_done(GObject *src, GAsyncResult *res, gpointer user_data)
{
    DialogJob    *job    = user_data;
    GtkFileDialog *dlg   = GTK_FILE_DIALOG(src);
    GError       *err    = NULL;
    GFile        *file;

    /* Which finish() applies is recorded by the caller in the dialog's data. */
    switch (GPOINTER_TO_INT(g_object_get_data(src, DIALOG_MODE_KEY))) {
    case DLG_FOLDER:
        file = gtk_file_dialog_select_folder_finish(dlg, res, &err);
        break;
    case DLG_SAVE:
        file = gtk_file_dialog_save_finish(dlg, res, &err);
        break;
    default:
        file = gtk_file_dialog_open_finish(dlg, res, &err);
        break;
    }

    char *path = file ? g_file_get_path(file) : NULL;
    g_clear_object(&file);
    g_clear_error(&err);   /* cancelling is not an error worth raising */

    dialog_job_finish(job, path);
}

/*
 * One `Filters` entry: a [label, patterns] pair.
 *
 *     Filters: [["Images", "*.png *.jpg *.svg"], ["All files", "*"]]
 *
 * A list of pairs and not `{ "Images": "*.png" }` for a reason that is not
 * taste: the label is prose, and prose in code is translated by the caller
 * (`Locale.Text("Images")`) exactly as a dialog title is.  A literal heading a
 * `Locale.Text` call is what the IDE's extractor collects; an object key would
 * have been invisible to it, so the convenient spelling is the one that quietly
 * cannot be translated.
 *
 * Patterns are space separated, and `*.ext` becomes a **suffix** rather than a
 * glob.  GTK's pattern matching is case sensitive, so `*.png` would not match
 * `PHOTO.PNG` -- which is not what anyone writing `*.png` means.  Anything else
 * is added as the glob it looks like.
 */
static bool dialog_add_filter(JSContext *ctx, GListStore *store,
                              JSValueConst filters, uint32_t i)
{
    JSValue pair = JS_GetPropertyUint32(ctx, filters, i);
    JSValue lv   = JS_UNDEFINED, pv = JS_UNDEFINED;

    if (JS_IsArray(pair)) {
        lv = JS_GetPropertyUint32(ctx, pair, 0);
        pv = JS_GetPropertyUint32(ctx, pair, 1);
    }
    if (!JS_IsString(lv) || !JS_IsString(pv)) {
        JS_FreeValue(ctx, lv);
        JS_FreeValue(ctx, pv);
        JS_FreeValue(ctx, pair);
        JS_ThrowTypeError(ctx,
            "Filters[%u] must be a [label, patterns] pair of strings, "
            "as [\"Images\", \"*.png *.jpg\"]", i);
        return false;
    }

    const char *label = JS_ToCString(ctx, lv);
    const char *pats  = JS_ToCString(ctx, pv);
    GtkFileFilter *f  = gtk_file_filter_new();
    int            n  = 0;

    gtk_file_filter_set_name(f, label);

    char **words = g_strsplit_set(pats ? pats : "", " \t\n", -1);
    for (int k = 0; words[k]; k++) {
        const char *p = words[k];
        if (!*p)
            continue;                              /* two spaces in a row */
        if (g_str_has_prefix(p, "*.") && !strpbrk(p + 2, "*?[]"))
            gtk_file_filter_add_suffix(f, p + 2);
        else
            gtk_file_filter_add_pattern(f, p);
        n++;
    }
    g_strfreev(words);

    JS_FreeCString(ctx, label);
    JS_FreeCString(ctx, pats);
    JS_FreeValue(ctx, lv);
    JS_FreeValue(ctx, pv);
    JS_FreeValue(ctx, pair);

    /* A filter with no pattern matches nothing, so it hides every file in the
     * chooser and looks like an empty directory.  Refused rather than shown. */
    if (n == 0) {
        g_object_unref(f);
        JS_ThrowTypeError(ctx, "Filters[%u] has no patterns", i);
        return false;
    }
    g_list_store_append(store, f);
    g_object_unref(f);
    return true;
}

static bool dialog_set_filters(JSContext *ctx, GtkFileDialog *dlg,
                               JSValueConst filters)
{
    if (!JS_IsArray(filters)) {
        JS_ThrowTypeError(ctx, "Filters must be a list of [label, patterns] pairs");
        return false;
    }

    JSValue  lenv = JS_GetPropertyStr(ctx, filters, "length");
    uint32_t n    = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    /* An empty list is not a complaint: it means the same as no `Filters` at
     * all, which is the rule `sources` in a project.json already follows. */
    if (n == 0)
        return true;

    GListStore *store = g_list_store_new(GTK_TYPE_FILE_FILTER);
    for (uint32_t i = 0; i < n; i++) {
        if (!dialog_add_filter(ctx, store, filters, i)) {
            g_object_unref(store);
            return false;
        }
    }

    gtk_file_dialog_set_filters(dlg, G_LIST_MODEL(store));

    /* The first one is what the dialog opens on: a list whose head is not the
     * filter you meant is a list in the wrong order. */
    GtkFileFilter *first = g_list_model_get_item(G_LIST_MODEL(store), 0);
    gtk_file_dialog_set_default_filter(dlg, first);
    g_object_unref(first);

    g_object_unref(store);       /* the dialog holds its own reference */
    return true;
}

/*
 * The optional options object, spelled the way `SourceEditor.Search`'s is:
 *
 *     { Folder, Name, Filters }
 *
 * `Folder` is where the chooser opens and `Name` the name it starts on -- the
 * one a save dialog puts in its field, and the file an open dialog preselects.
 */
static bool dialog_apply_options(JSContext *ctx, GtkFileDialog *dlg,
                                 JSValueConst opts)
{
    if (JS_IsUndefined(opts) || JS_IsNull(opts))
        return true;

    if (!JS_IsObject(opts)) {
        JS_ThrowTypeError(ctx, "the options are an object: { Folder, Name, Filters }");
        return false;
    }

    JSValue v = JS_GetPropertyStr(ctx, opts, "Folder");
    if (JS_IsString(v)) {
        const char *s = JS_ToCString(ctx, v);
        GFile      *f = g_file_new_for_path(s);
        gtk_file_dialog_set_initial_folder(dlg, f);
        g_object_unref(f);
        JS_FreeCString(ctx, s);
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, opts, "Name");
    if (JS_IsString(v)) {
        const char *s = JS_ToCString(ctx, v);
        gtk_file_dialog_set_initial_name(dlg, s);
        JS_FreeCString(ctx, s);
    }
    JS_FreeValue(ctx, v);

    v = JS_GetPropertyStr(ctx, opts, "Filters");
    bool ok = JS_IsUndefined(v) || dialog_set_filters(ctx, dlg, v);
    JS_FreeValue(ctx, v);
    return ok;
}

static JSValue sys_dialog(JSContext *ctx, JSValueConst this_val,
                          int argc, JSValueConst *argv, int magic)
{
    const char *title = argc > 0 && JS_IsString(argv[0])
                            ? JS_ToCString(ctx, argv[0]) : NULL;

    /*
     * (title, cb) or (title, options, cb).  Which one is decided by type
     * rather than by counting: the callback is the argument that is a function,
     * so the options stay optional without an overload per shape.
     */
    int          i    = 1;
    JSValueConst opts = JS_UNDEFINED;
    if (argc > i && !JS_IsFunction(ctx, argv[i]))
        opts = argv[i++];
    JSValueConst cb = argc > i ? argv[i] : JS_UNDEFINED;

    if (!JS_IsFunction(ctx, cb)) {
        JS_FreeCString(ctx, title);
        return JS_ThrowTypeError(ctx, "a callback is required: the dialog is async");
    }

    GtkFileDialog *dlg = gtk_file_dialog_new();
    if (title)
        gtk_file_dialog_set_title(dlg, title);
    JS_FreeCString(ctx, title);

    /* Refused options throw with the offending value, as every setter in this
     * runtime does -- before anything asynchronous is under way to be left
     * half started. */
    if (!dialog_apply_options(ctx, dlg, opts)) {
        g_object_unref(dlg);
        return JS_EXCEPTION;
    }

    DialogJob *job = g_new0(DialogJob, 1);
    job->ctx = ctx;
    job->cb  = JS_DupValue(ctx, cb);
    dialog_jobs = g_list_prepend(dialog_jobs, job);

    BtaApp    *app    = bta_current_app();
    GtkWindow *parent = app && app->gapp
                            ? gtk_application_get_active_window(app->gapp) : NULL;

    g_object_set_data(G_OBJECT(dlg), DIALOG_MODE_KEY, GINT_TO_POINTER(magic));

    switch (magic) {
    case DLG_FOLDER:
        gtk_file_dialog_select_folder(dlg, parent, NULL, on_dialog_done, job);
        break;
    case DLG_SAVE:
        gtk_file_dialog_save(dlg, parent, NULL, on_dialog_done, job);
        break;
    default:
        gtk_file_dialog_open(dlg, parent, NULL, on_dialog_done, job);
        break;
    }
    g_object_unref(dlg);
    return JS_UNDEFINED;
}

/*
 * Dialog.Color(title, current, cb) -- the desktop's colour chooser.
 *
 * This one cannot be a Bintana form the way AskForm and the icon chooser are:
 * a colour wheel is not something the widget set can be talked into being. So
 * it is a primitive, and the same asynchronous bargain as the file dialogs --
 * GTK4 has no modal answer to give.
 *
 * What comes back is a CSS colour string, which is exactly what Background and
 * Foreground take: the chooser hands over what the property was going to be
 * assigned anyway. Cancelling calls nothing, which is how "never mind" stays
 * different from "no colour".
 */
static void on_color_done(GObject *src, GAsyncResult *res, gpointer user_data)
{
    DialogJob      *job = user_data;
    GtkColorDialog *dlg = GTK_COLOR_DIALOG(src);
    GError         *err = NULL;

    GdkRGBA *rgba = gtk_color_dialog_choose_rgba_finish(dlg, res, &err);
    char    *css  = rgba ? gdk_rgba_to_string(rgba) : NULL;

    if (rgba)
        gdk_rgba_free(rgba);
    g_clear_error(&err);          /* cancelling is not an error worth raising */

    /* The same finish as a file dialog's: a heap string handed to the callback
     * and freed, or nothing at all. */
    dialog_job_finish(job, css);
}

static JSValue sys_color_dialog(JSContext *ctx, JSValueConst this_val,
                                int argc, JSValueConst *argv)
{
    const char *title   = argc > 0 && JS_IsString(argv[0])
                              ? JS_ToCString(ctx, argv[0]) : NULL;
    const char *current = argc > 1 && JS_IsString(argv[1])
                              ? JS_ToCString(ctx, argv[1]) : NULL;

    JSValueConst cb = argc > 2 ? argv[2] : JS_UNDEFINED;

    if (!JS_IsFunction(ctx, cb)) {
        JS_FreeCString(ctx, title);
        JS_FreeCString(ctx, current);
        return JS_ThrowTypeError(ctx,
            "Dialog.Color(title, current, cb) needs a callback: it is async");
    }

    GtkColorDialog *dlg = gtk_color_dialog_new();
    if (title)
        gtk_color_dialog_set_title(dlg, title);

    /* Where the wheel opens. A colour that does not parse is not an error: it
     * simply means there is nothing to start from. */
    GdkRGBA  start;
    GdkRGBA *from = NULL;
    if (current && *current && gdk_rgba_parse(&start, current))
        from = &start;

    JS_FreeCString(ctx, title);
    JS_FreeCString(ctx, current);

    DialogJob *job = g_new0(DialogJob, 1);
    job->ctx = ctx;
    job->cb  = JS_DupValue(ctx, cb);
    dialog_jobs = g_list_prepend(dialog_jobs, job);

    BtaApp    *app    = bta_current_app();
    GtkWindow *parent = app && app->gapp
                            ? gtk_application_get_active_window(app->gapp) : NULL;

    gtk_color_dialog_choose_rgba(dlg, parent, from, NULL, on_color_done, job);
    g_object_unref(dlg);
    return JS_UNDEFINED;
}

/*
 * monotonic() -- milliseconds on a clock that only ever goes forward.
 *
 * **The one thing `Date` cannot do.**  A `Date` is the wall clock, and a wall
 * clock is a *setting*: NTP steps it, a timezone change moves it, somebody fixes
 * it by hand.  Any of those during a measurement makes the answer wrong, and a
 * step backwards makes it **negative** -- which is how a stopwatch built on
 * `Date.now()` reports a lap that took minus four seconds.
 *
 * `g_get_monotonic_time()` is the clock the GLib main loop already schedules
 * every `Timer` against, so this is not a second notion of time in the runtime:
 * it is the one that was already there, published.  It counts from an
 * unspecified point -- the machine's boot, on Linux -- so a single reading means
 * nothing and only the **difference between two** does.  Which is exactly why
 * the name a project sees is `Stopwatch` and not this one: a bare number nobody
 * can interpret invites being printed, stored, or compared against a date.
 * rad.js captures it and `close_hatches` takes the name away, on the same terms
 * as `setTimeout` and for the same reason.
 *
 * Microseconds underneath, handed out as milliseconds with the fraction kept:
 * `Timer` speaks milliseconds, so a duration measured here is in the same unit
 * as the delay that was asked for, and something timing a loop still gets the
 * places it needs.
 */
static JSValue js_monotonic(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    return JS_NewFloat64(ctx, g_get_monotonic_time() / 1000.0);
}

/*
 * `File.LoadBytes(path)` and `File.SaveBytes(path, bytes)`.
 *
 * The pair `Load`/`Save` could not be: they are UTF-8 text, so a PNG read
 * through them comes back with its bytes replaced and written back out
 * destroyed. These are the same two operations with nothing in the way, and the
 * value they carry is a `Bytes`.
 *
 * They are separate calls rather than a flag on the existing pair because the
 * *return type* is what differs, and a function whose answer is a string or an
 * object depending on an argument is the shape every caller gets wrong once.
 */
static JSValue sys_file_load_bytes(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "File.LoadBytes(path) needs a path");

    char   *data = NULL;
    gsize   len  = 0;
    GError *err  = NULL;

    if (!g_file_get_contents(path, &data, &len, &err)) {
        JSValue e = JS_ThrowInternalError(ctx, "cannot read %s: %s", path,
                                          err ? err->message : "unknown error");
        g_clear_error(&err);
        JS_FreeCString(ctx, path);
        return e;
    }

    JSValue out = bta_bytes_new(ctx, data, len);
    g_free(data);
    JS_FreeCString(ctx, path);
    return out;
}

static JSValue sys_file_save_bytes(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "File.SaveBytes(path, bytes) needs a path");

    size_t         len   = 0;
    const uint8_t *bytes = argc > 1 ? bta_bytes_get(argv[1], &len) : NULL;

    if (!bytes) {
        JS_FreeCString(ctx, path);
        return JS_ThrowTypeError(ctx, "File.SaveBytes(path, bytes) needs a Bytes "
                                      "-- File.Save is the one that takes text");
    }

    GError *err = NULL;
    bool    ok  = g_file_set_contents(path, (const char *)bytes, (gssize)len, &err);

    if (!ok) {
        JSValue e = JS_ThrowInternalError(ctx, "cannot write %s: %s", path,
                                          err ? err->message : "unknown error");
        g_clear_error(&err);
        JS_FreeCString(ctx, path);
        return e;
    }
    JS_FreeCString(ctx, path);
    return JS_UNDEFINED;
}

/* ------------------------------------------------------------------ Hash
 *
 * A checksum, which is the one thing a program cannot talk itself out of
 * needing: a file compared against a published digest, a cache key off a value
 * in memory, a password checked against what was stored.
 *
 * Before this the answer was `Exec(["sha256sum", path])` and parsing the first
 * field -- a child process, a tool that has to be installed, and an output
 * format the program does not own -- and for a value that was never on disk
 * there was no answer at all.
 *
 * **The implementation is GLib's** (`GChecksum`), already linked, so what is
 * written here is the surface and the refusals: which algorithms, hex out, and a
 * file read in chunks rather than loaded whole.
 */

static const struct { const char *name; GChecksumType type; } HASHES[] = {
    { "Md5",    G_CHECKSUM_MD5 },
    { "Sha1",   G_CHECKSUM_SHA1 },
    { "Sha256", G_CHECKSUM_SHA256 },
    { "Sha512", G_CHECKSUM_SHA512 },
};

enum { HASH_MD5, HASH_SHA1, HASH_SHA256, HASH_SHA512 };   /* HASHES' own order */

/*
 * A string's digest -- or a `Bytes`'s, which is the case this exists for.
 *
 * **What is hashed is the text's UTF-8 bytes** -- what every other tool means
 * by the hash of a string, so a digest computed here matches `sha256sum` over
 * the same text in a file. A `Bytes` is hashed as the bytes it is, which is the
 * case a checksum is for and the one that had no answer at all until there was
 * a value to carry a file in. A value that is not text has to
 * become text first (`JSON.stringify`, a `Decimal`'s own digits), and that is
 * the caller's decision because the encoding is part of what was hashed.
 */
static JSValue sys_hash_text(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv, int magic)
{
    if (argc < 1)
        return JS_ThrowTypeError(ctx, "Hash.%s(text) needs the text", HASHES[magic].name);

    /* A `Bytes` is hashed as the bytes it is -- which is the case a checksum
     * is *for*, and the one that had no answer at all before there was a value
     * to carry a file in. Text is still text, hashed as its UTF-8. */
    size_t         len   = 0;
    const uint8_t *bytes = bta_bytes_get(argv[0], &len);
    const char    *text  = NULL;

    if (!bytes) {
        text = JS_ToCStringLen(ctx, &len, argv[0]);
        if (!text)
            return JS_EXCEPTION;
        bytes = (const uint8_t *)text;
    }

    char *hex = g_compute_checksum_for_data(HASHES[magic].type,
                                            (const guchar *)bytes, len);
    JSValue out = JS_NewString(ctx, hex ? hex : "");

    g_free(hex);
    if (text)
        JS_FreeCString(ctx, text);
    return out;
}

/*
 * Written out rather than built in a loop over `HASHES`, and that is not
 * repetition for its own sake: `tests/api.sh` reads these tables out of the C to
 * hold `llm/library.md` to being complete, and a member whose name is only ever
 * a variable is a member the check cannot see. A surface nobody can enumerate is
 * a surface nobody has to document.
 */
static const JSCFunctionListEntry hash_props[] = {
    JS_CFUNC_MAGIC_DEF("Md5",    1, sys_hash_text, HASH_MD5),
    JS_CFUNC_MAGIC_DEF("Sha1",   1, sys_hash_text, HASH_SHA1),
    JS_CFUNC_MAGIC_DEF("Sha256", 1, sys_hash_text, HASH_SHA256),
    JS_CFUNC_MAGIC_DEF("Sha512", 1, sys_hash_text, HASH_SHA512),
};

/* Which algorithm a name means, or -1 with the list said out loud. */
static int hash_kind(JSContext *ctx, JSValueConst v, const char *who)
{
    const char *name = JS_ToCString(ctx, v);
    if (!name)
        return -1;

    for (size_t i = 0; i < G_N_ELEMENTS(HASHES); i++) {
        if (g_ascii_strcasecmp(name, HASHES[i].name) == 0) {
            JS_FreeCString(ctx, name);
            return (int)i;
        }
    }

    GString *list = g_string_new(NULL);
    for (size_t i = 0; i < G_N_ELEMENTS(HASHES); i++)
        g_string_append_printf(list, i ? ", %s" : "%s", HASHES[i].name);

    JS_ThrowTypeError(ctx, "%s: '%s' is not one of %s", who, name, list->str);
    g_string_free(list, TRUE);
    JS_FreeCString(ctx, name);
    return -1;
}

/*
 * `File.Hash(path, [algorithm])`: the file's digest, **without loading it**.
 *
 * 64 KB at a time, so the checksum of a video costs 64 KB of memory and not the
 * video. `File.Load` would also work and is what the issue that asked for this
 * offered as the workaround -- but a hash is exactly the operation that wants a
 * file it cannot hold, and a text load would also refuse anything that is not
 * UTF-8, which is most of what gets hashed.
 */
static JSValue sys_file_hash(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    const char *path = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!path)
        return JS_ThrowTypeError(ctx, "File.Hash(path, [algorithm]) needs a path");

    int kind = HASH_SHA256;                        /* the one people mean */
    if (argc > 1 && !JS_IsUndefined(argv[1])) {
        kind = hash_kind(ctx, argv[1], "File.Hash");
        if (kind < 0) {
            JS_FreeCString(ctx, path);
            return JS_EXCEPTION;
        }
    }

    FILE *f = g_fopen(path, "rb");
    if (!f) {
        JSValue e = JS_ThrowInternalError(ctx, "File.Hash: cannot read '%s': %s",
                                          path, g_strerror(errno));
        JS_FreeCString(ctx, path);
        return e;
    }

    GChecksum *sum = g_checksum_new(HASHES[kind].type);
    guchar     buf[65536];
    size_t     got;

    while ((got = fread(buf, 1, sizeof buf, f)) > 0)
        g_checksum_update(sum, buf, got);

    bool failed = ferror(f) != 0;
    fclose(f);

    if (failed) {
        JSValue e = JS_ThrowInternalError(ctx, "File.Hash: cannot read '%s': %s",
                                          path, g_strerror(errno));
        g_checksum_free(sum);
        JS_FreeCString(ctx, path);
        return e;
    }

    JSValue out = JS_NewString(ctx, g_checksum_get_string(sum));
    g_checksum_free(sum);
    JS_FreeCString(ctx, path);
    return out;
}

/* ------------------------------------------------------------------ init */

void bta_sys_init(JSContext *ctx, JSValue global)
{
    JSValue file = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, file, "Load",   JS_NewCFunction(ctx, sys_file_load, "Load", 1));
    JS_SetPropertyStr(ctx, file, "Save",   JS_NewCFunction(ctx, sys_file_save, "Save", 2));
    JS_SetPropertyStr(ctx, file, "Delete", JS_NewCFunction(ctx, sys_file_delete, "Delete", 1));
    JS_SetPropertyStr(ctx, file, "Open",
                      JS_NewCFunction(ctx, sys_file_open, "Open", 1));
    JS_SetPropertyStr(ctx, file, "Info",
                      JS_NewCFunction(ctx, sys_file_info, "Info", 1));
    JS_SetPropertyStr(ctx, file, "Watch",
                      JS_NewCFunction(ctx, sys_file_watch, "Watch", 2));
    JS_SetPropertyStr(ctx, file, "Copy",
                      JS_NewCFunction(ctx, sys_file_copy, "Copy", 2));
    JS_SetPropertyStr(ctx, file, "Trash",
                      JS_NewCFunction(ctx, sys_file_trash, "Trash", 1));
    JS_SetPropertyStr(ctx, file, "Rename", JS_NewCFunction(ctx, sys_file_rename, "Rename", 2));
    JS_SetPropertyStr(ctx, file, "Hash",
                      JS_NewCFunction(ctx, sys_file_hash, "Hash", 2));
    JS_SetPropertyStr(ctx, file, "LoadBytes",
                      JS_NewCFunction(ctx, sys_file_load_bytes, "LoadBytes", 1));
    JS_SetPropertyStr(ctx, file, "SaveBytes",
                      JS_NewCFunction(ctx, sys_file_save_bytes, "SaveBytes", 2));
    JS_SetPropertyStr(ctx, file, "Join",   JS_NewCFunction(ctx, sys_file_join, "Join", 2));
    JS_SetPropertyStr(ctx, file, "Absolute",
                      JS_NewCFunction(ctx, sys_file_absolute, "Absolute", 1));
    JS_SetPropertyStr(ctx, file, "Exists",
                      JS_NewCFunctionMagic(ctx, sys_file_test, "Exists", 1,
                                           JS_CFUNC_generic_magic, FT_EXISTS));
    JS_SetPropertyStr(ctx, file, "IsDir",
                      JS_NewCFunctionMagic(ctx, sys_file_test, "IsDir", 1,
                                           JS_CFUNC_generic_magic, FT_ISDIR));

    static const struct { const char *name; int magic; } parts[] = {
        { "Name",      BTA_PATH_NAME },
        { "Directory", BTA_PATH_DIR },
        { "Extension", BTA_PATH_EXT },
        { "BaseName",  BTA_PATH_BASENAME },
    };
    for (size_t i = 0; i < G_N_ELEMENTS(parts); i++)
        JS_SetPropertyStr(ctx, file, parts[i].name,
                          JS_NewCFunctionMagic(ctx, sys_path_part, parts[i].name, 1,
                                               JS_CFUNC_generic_magic, parts[i].magic));
    JS_SetPropertyStr(ctx, global, "File", file);

    JSValue hash = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, hash, hash_props, G_N_ELEMENTS(hash_props));
    JS_SetPropertyStr(ctx, global, "Hash", hash);

    JSValue screen = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, screen, screen_props, G_N_ELEMENTS(screen_props));
    JS_SetPropertyStr(ctx, global, "Screen", screen);

    JSValue dir = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, dir, "List", JS_NewCFunction(ctx, sys_dir_list, "List", 2));
    JS_SetPropertyStr(ctx, dir, "Files",
                      JS_NewCFunctionMagic(ctx, sys_dir_walk, "Files", 2,
                                           JS_CFUNC_generic_magic, 0));
    JS_SetPropertyStr(ctx, dir, "Folders",
                      JS_NewCFunctionMagic(ctx, sys_dir_walk, "Folders", 2,
                                           JS_CFUNC_generic_magic, 1));
    JS_SetPropertyStr(ctx, dir, "Make", JS_NewCFunction(ctx, sys_dir_make, "Make", 1));
    JS_SetPropertyStr(ctx, dir, "Copy", JS_NewCFunction(ctx, sys_dir_copy, "Copy", 2));
    JS_SetPropertyStr(ctx, dir, "Delete",
                      JS_NewCFunction(ctx, sys_dir_delete, "Delete", 1));
    JS_SetPropertyStr(ctx, dir, "DeleteTree",
                      JS_NewCFunction(ctx, sys_dir_delete_tree, "DeleteTree", 1));
    JS_SetPropertyStr(ctx, global, "Directory", dir);

    /* Wait hangs off Exec the way After hangs off Timer: asynchronous is this
     * language's default, so the plain call keeps the plain name. */
    JSValue exec = JS_NewCFunction(ctx, sys_exec, "Exec", 4);
    JS_SetPropertyStr(ctx, exec, "Wait",
                      JS_NewCFunction(ctx, sys_exec_wait, "Wait", 2));
    JS_SetPropertyStr(ctx, global, "Exec", exec);

    /* The clock a duration is measured on, held by rad.js for `Stopwatch` and
     * then taken away with the rest of the raw primitives. */
    JS_SetPropertyStr(ctx, global, "monotonic",
                      JS_NewCFunction(ctx, js_monotonic, "monotonic", 0));

    JS_SetPropertyStr(ctx, global, "setTimeout",
                      JS_NewCFunctionMagic(ctx, sys_set_timer, "setTimeout", 2,
                                           JS_CFUNC_generic_magic, 0));
    JS_SetPropertyStr(ctx, global, "setInterval",
                      JS_NewCFunctionMagic(ctx, sys_set_timer, "setInterval", 2,
                                           JS_CFUNC_generic_magic, 1));
    JS_SetPropertyStr(ctx, global, "clearTimeout",
                      JS_NewCFunction(ctx, sys_clear_timer, "clearTimeout", 1));
    JS_SetPropertyStr(ctx, global, "clearInterval",
                      JS_NewCFunction(ctx, sys_clear_timer, "clearInterval", 1));

    JSValue env = JS_NewObject(ctx);
    JS_SetPropertyFunctionList(ctx, env, env_props, G_N_ELEMENTS(env_props));

    /*
     * Read once and published as values, because none of them can change while
     * the process runs: a getter for a constant is ceremony, and a program that
     * reports where it ran reads all of them at once anyway.
     *
     * The three directories are named alike on purpose -- `CurrentDirectory` is
     * the one that moves, and it looks like the two that do not.
     */
    JS_SetPropertyStr(ctx, env, "HomeDirectory", JS_NewString(ctx, g_get_home_dir()));
    JS_SetPropertyStr(ctx, env, "TempDirectory", JS_NewString(ctx, g_get_tmp_dir()));
    JS_SetPropertyStr(ctx, env, "UserName", JS_NewString(ctx, g_get_user_name()));
    JS_SetPropertyStr(ctx, env, "HostName", JS_NewString(ctx, g_get_host_name()));
    /* The pid: what names a scratch directory so two runs of the same tool do
     * not edit each other's files -- which the test suite passes by hand today,
     * because there was nothing to read it from. */
    JS_SetPropertyStr(ctx, env, "ProcessId", JS_NewInt32(ctx, (int32_t)getpid()));
    /* How wide to build, which is the one number `-j` wants. */
    JS_SetPropertyStr(ctx, env, "ProcessorCount",
                      JS_NewInt32(ctx, (int32_t)g_get_num_processors()));

#ifdef G_OS_WIN32
    {
        /* The same two questions `uname` answers, asked of GLib: POSIX has
         * `uname` and Windows has this. */
        char *name    = g_get_os_info(G_OS_INFO_KEY_NAME);
        char *version = g_get_os_info(G_OS_INFO_KEY_VERSION);

        JS_SetPropertyStr(ctx, env, "OS",
                          JS_NewString(ctx, name ? name : "Windows"));
        JS_SetPropertyStr(ctx, env, "OSVersion",
                          JS_NewString(ctx, version ? version : ""));
        g_free(name);
        g_free(version);
    }
#else
    struct utsname sys;
    if (uname(&sys) == 0) {
        JS_SetPropertyStr(ctx, env, "OS", JS_NewString(ctx, sys.sysname));
        JS_SetPropertyStr(ctx, env, "OSVersion", JS_NewString(ctx, sys.release));
    } else {
        JS_SetPropertyStr(ctx, env, "OS", JS_NewString(ctx, ""));
        JS_SetPropertyStr(ctx, env, "OSVersion", JS_NewString(ctx, ""));
    }
#endif

    JS_SetPropertyStr(ctx, global, "Environment", env);

    JSValue dialog = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, dialog, "SelectFolder",
                      JS_NewCFunctionMagic(ctx, sys_dialog, "SelectFolder", 2,
                                           JS_CFUNC_generic_magic, DLG_FOLDER));
    JS_SetPropertyStr(ctx, dialog, "OpenFile",
                      JS_NewCFunctionMagic(ctx, sys_dialog, "OpenFile", 2,
                                           JS_CFUNC_generic_magic, DLG_FILE));
    JS_SetPropertyStr(ctx, dialog, "SaveFile",
                      JS_NewCFunctionMagic(ctx, sys_dialog, "SaveFile", 2,
                                           JS_CFUNC_generic_magic, DLG_SAVE));
    JS_SetPropertyStr(ctx, dialog, "Color",
                      JS_NewCFunction(ctx, sys_color_dialog, "Color", 3));
    JS_SetPropertyStr(ctx, global, "Dialog", dialog);

    JSValue clipboard = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, clipboard, "Copy",
                      JS_NewCFunction(ctx, sys_clip_copy, "Copy", 1));
    JS_SetPropertyStr(ctx, clipboard, "Paste",
                      JS_NewCFunction(ctx, sys_clip_paste, "Paste", 1));
    JS_SetPropertyStr(ctx, global, "Clipboard", clipboard);
}

/*
 * What is still owed an answer.
 *
 * Three kinds, and they are the three that can call back into JS after the code
 * that asked for them has returned: a child still running, a timer still armed,
 * a file still watched.  A console project whose `main` returns with none of
 * them has nothing left to do and ends; one that spawned a child waits for it
 * without being told to.
 *
 * The dialogs and the clipboard are not counted: they belong to a window, and a
 * project with a window is not the one asking.
 */
guint bta_sys_pending(void)
{
    return g_list_length(exec_jobs) + g_list_length(watch_jobs)
           + (timers ? g_hash_table_size(timers) : 0);
}

void bta_sys_cleanup(void)
{
    /* Anything outliving the runtime would leave its callbacks referenced
     * after the context dies, which JS_FreeRuntime asserts on. */
    while (exec_jobs) {
        ExecJob *job = exec_jobs->data;
        g_cancellable_cancel(job->cancel);
        exec_job_free(job);
    }
    while (watch_jobs)
        watch_job_free(watch_jobs->data);
    while (paste_jobs) {
        PasteJob *job = paste_jobs->data;
        paste_jobs = g_list_remove(paste_jobs, job);
        JS_FreeValue(job->ctx, job->cb);
        g_free(job);
    }
    while (dialog_jobs) {
        DialogJob *job = dialog_jobs->data;
        dialog_jobs = g_list_remove(dialog_jobs, job);
        JS_FreeValue(job->ctx, job->cb);
        g_free(job);
    }

    if (timers) {
        /* Snapshot the ids: removing a source runs timer_destroy, which
         * mutates the table we would otherwise be iterating. */
        GList *ids = g_hash_table_get_keys(timers);
        for (GList *l = ids; l; l = l->next)
            g_source_remove(GPOINTER_TO_UINT(l->data));
        g_list_free(ids);

        g_hash_table_destroy(timers);
        timers = NULL;
    }
}
