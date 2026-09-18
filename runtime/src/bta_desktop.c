/*
 * Desktop: the session a program is running in, and the desktop entries a user
 * installs for themselves.
 *
 * Two things, one object, because they are the same subject.  `Desktop` answers
 * the XDG directories -- where a program's own data, configuration and cache
 * belong (`DataDirectory`, `ConfigDirectory`, `CacheDirectory`) -- and
 * `Desktop.Entries` is the module that reads and writes the `.desktop` files of
 * `$XDG_DATA_HOME/applications`, which is where a user's own menu entries live.
 *
 * **The parsing and the writing are GLib's and not ours.**  A `.desktop` file is
 * a key file, and `GKeyFile` is the implementation of that format: the escaping,
 * the localized keys (`Name[es]`), the value syntax.  A hand-written parser in
 * JS would be another answer to a question the platform already answers, and the
 * one place it would show is the day somebody's name has a backslash in it.
 *
 * **What this is for**: a program -- today the IDE, for the project it has open
 * -- can put itself in the user's menu without root and without a package.  That
 * is one `.desktop` file under the user's own data directory and nothing else:
 * no index to update, no daemon to tell.  `docs/installing.md` is the two
 * halves, the system install and this one.
 *
 * **The verbs refuse rather than do something approximate**, in the way this
 * runtime refuses everywhere: an id that could be a path, an entry with no
 * `[Desktop Entry]` group, an `Exec` that is not text.  The desktop itself
 * ignores a broken entry in silence, which is exactly the failure this is here
 * to prevent -- a user who installed something and cannot see it has nothing to
 * read and nowhere to look.
 */
#include "bta.h"

#include <glib/gstdio.h>
#include <string.h>

/* --------------------------------------------------------------------- paths
 *
 * The user's applications directory: `$XDG_DATA_HOME/applications`, which GLib
 * spells out of the environment and a fallback (`~/.local/share`).  It is read
 * through `g_get_user_data_dir` and never assembled by hand for the reason the
 * XDG variables exist: a machine that moved its data home would have a program
 * that writes entries nobody reads.
 */
static char *entries_dir(void)
{
    return g_build_filename(g_get_user_data_dir(), "applications", NULL);
}

static char *entries_path(const char *id)
{
    char *dir  = entries_dir();
    char *name = g_strconcat(id, ".desktop", NULL);
    char *path = g_build_filename(dir, name, NULL);

    g_free(dir);
    g_free(name);
    return path;
}

/*
 * An id is the file's name without the extension, and it has to be one the
 * desktop specification would accept: letters, digits, `-`, `_` and `.`.
 *
 * The two refusals are the ones that would otherwise be silent.  A separator
 * would make `Install("../x", …)` write outside the directory this owns -- and
 * `Read` would then read a file that is not an entry at all.  A trailing
 * `.desktop` is what somebody types when they think the id is the file name;
 * taken as it stands it would install `hello.desktop.desktop`, which the menu
 * shows once and which nobody can find again.
 */
static bool entries_id(JSContext *ctx, const char *id, const char *who)
{
    if (!id || !*id)
        return JS_ThrowTypeError(ctx, "%s needs an id", who), false;

    if (g_str_has_suffix(id, ".desktop"))
        return JS_ThrowTypeError(ctx,
            "%s: \"%s\" is a file name; the id is what comes before .desktop",
            who, id), false;

    if (id[0] == '.')
        return JS_ThrowTypeError(ctx,
            "%s: \"%s\" is not an application id", who, id), false;

    for (const char *p = id; *p; p++) {
        if (g_ascii_isalnum(*p) || *p == '-' || *p == '_' || *p == '.')
            continue;
        return JS_ThrowTypeError(ctx,
            "%s: \"%s\" is not an application id: letters, digits, '-', '_' "
            "and '.' only",
            who, id), false;
    }
    return true;
}

/* ---------------------------------------------------------------------- Exec
 *
 * `Desktop.Entries.Exec(argv)`: what goes after `Exec=` for that command.
 *
 * **A desktop entry keeps a command as a string, and the string has its own
 * quoting** -- and it is not the shell's, it is not ours, and it is applied on
 * top of the key file's escaping, which is why nobody should write it by hand.
 * Measured against `gio launch` (a real `GDesktopAppInfo`, the same road a menu
 * takes):
 *
 *   - Every argument is quoted with double quotes, so a space is ordinary.
 *   - `"`, `` ` ``, `$` and `\` are escaped with a backslash inside them.
 *   - `%` is the field-code marker (`%f`, `%u`, `%U`), so a literal one is
 *     written twice; the first `%` of `%%` is what survives.
 *
 * The backslashes this leaves in the value are *not* what a file shows: the
 * key file escapes them again as it writes (`\\`), and the parser below undoes
 * that before the Exec rules are read.  That two-layer business is the whole
 * argument for this being a verb and not a line in an application.
 */
static JSValue entries_exec(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    if (argc < 1 || !JS_IsArray(argv[0]))
        return JS_ThrowTypeError(ctx,
            "Desktop.Entries.Exec(argv) needs an array of arguments");

    JSValue lenv = JS_GetPropertyStr(ctx, argv[0], "length");
    int32_t n = 0;
    JS_ToInt32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    GString *out = g_string_new(NULL);

    for (int32_t i = 0; i < n; i++) {
        JSValue     v = JS_GetPropertyUint32(ctx, argv[0], i);
        const char *s = JS_IsString(v) ? JS_ToCString(ctx, v) : NULL;

        if (!s) {
            g_string_free(out, TRUE);
            JSValue e = JS_ThrowTypeError(ctx,
                "Desktop.Entries.Exec: argument %d is not text", i);
            JS_FreeValue(ctx, v);
            return e;
        }
        JS_FreeValue(ctx, v);
        if (i)
            g_string_append_c(out, ' ');

        g_string_append_c(out, '"');
        for (const char *p = s; *p; p++) {
            switch (*p) {
            case '"': case '\\': case '$': case '`':
                g_string_append_c(out, '\\');
                g_string_append_c(out, *p);
                break;
            case '%':
                g_string_append(out, "%%");
                break;
            default:
                g_string_append_c(out, *p);
            }
        }
        g_string_append_c(out, '"');
        JS_FreeCString(ctx, s);
    }

    JSValue r = JS_NewStringLen(ctx, out->str, out->len);
    g_string_free(out, TRUE);
    return r;
}

/* ---------------------------------------------------------------------- Read
 *
 * `Desktop.Entries.Read(id)` -- the whole file as data:
 * `{ "Desktop Entry": { Name: …, Exec: … }, "Desktop Action new": { … } }`, or
 * `null` when there is no such entry.  That is the exact shape `Install` takes,
 * so one is read, changed and written back.
 *
 * Values come back **unescaped**, which is what a caller wants: `Name` is the
 * name and not the bytes between `=` and the newline.  Comments and blank lines
 * are not part of the shape and do not survive a rewrite -- this is for entries
 * a program installs and removes, not for editing a packager's file.
 *
 * **`G_KEY_FILE_KEEP_TRANSLATIONS` is load-bearing, and its absence is
 * silent.**  Without it `GKeyFile` keeps a `Key[locale]` only when the locale
 * is one of `g_get_language_names()`'s -- the desktop's language -- and drops
 * the rest.  So `Name[es]` was a key on a machine set to Spanish and was not on
 * one set to English, and an entry read on the wrong machine came back with its
 * translations gone.  The failure is invisible where it is written: a test that
 * passes in `es_AR` and fails on CI's `C`.  A file this runtime reads to write
 * back wants every key it has, whatever language this machine speaks.
 */
static JSValue entries_read(JSContext *ctx, JSValueConst this_val,
                            int argc, JSValueConst *argv)
{
    const char *id = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!id)
        return JS_ThrowTypeError(ctx, "Desktop.Entries.Read(id) needs an id");
    if (!entries_id(ctx, id, "Desktop.Entries.Read")) {
        JS_FreeCString(ctx, id);
        return JS_EXCEPTION;
    }

    char  *path = entries_path(id);
    JSValue out = JS_NULL;

    /* Absent is an answer and not a fault: asking about an entry that is not
     * installed is how a program finds out that it is not installed. */
    if (g_file_test(path, G_FILE_TEST_EXISTS)) {
        GKeyFile *kf  = g_key_file_new();
        GError   *err = NULL;

        if (!g_key_file_load_from_file(kf, path, G_KEY_FILE_KEEP_TRANSLATIONS,
                                       &err)) {
            out = JS_ThrowInternalError(ctx, "cannot read %s: %s", path,
                                        err ? err->message : "unknown error");
            g_clear_error(&err);
        } else {
            out = JS_NewObject(ctx);
            gchar **groups = g_key_file_get_groups(kf, NULL);

            for (int i = 0; groups && groups[i] && !JS_IsException(out); i++) {
                JSValue  group = JS_NewObject(ctx);
                gsize    n     = 0;
                gchar  **keys  = g_key_file_get_keys(kf, groups[i], &n, &err);

                if (!keys) {
                    /* The half-built object goes before the exception takes its
                     * place: overwriting it would leave the reference behind. */
                    JS_FreeValue(ctx, out);
                    out = JS_ThrowInternalError(ctx, "cannot read %s: %s", path,
                                                err ? err->message : "unknown error");
                    g_clear_error(&err);
                    JS_FreeValue(ctx, group);
                    break;
                }
                for (gsize k = 0; k < n; k++) {
                    gchar *val = g_key_file_get_string(kf, groups[i], keys[k], &err);

                    if (!val) {
                        JS_FreeValue(ctx, out);
                        out = JS_ThrowInternalError(ctx,
                            "cannot read %s: %s in [%s]", path,
                            err ? err->message : "invalid value", groups[i]);
                        g_clear_error(&err);
                        break;
                    }
                    JS_SetPropertyStr(ctx, group, keys[k], JS_NewString(ctx, val));
                    g_free(val);
                }
                g_strfreev(keys);
                if (JS_IsException(out)) {
                    JS_FreeValue(ctx, group);
                    break;
                }
                JS_SetPropertyStr(ctx, out, groups[i], group);
            }
            g_strfreev(groups);
        }
        g_key_file_free(kf);
    }

    g_free(path);
    JS_FreeCString(ctx, id);
    return out;
}

/* ------------------------------------------------------------------- Install
 *
 * `Desktop.Entries.Install(id, entry)` -- writes `Directory/<id>.desktop` and
 * answers the path it wrote.
 *
 * **It is refused unless it is an entry.**  No `[Desktop Entry]` group, or a
 * group with no `Type` or no `Name`, is a file the menu skips without a word --
 * the desktop specification makes all three mandatory and every implementation
 * is allowed to ignore what does not follow it.  A `Type=Application` with no
 * `Exec` is the same silence: a menu item that is offered and does nothing.  A
 * program that wants to write something else wants `File.Save`.
 *
 * The write is `g_file_set_contents`, which is the same promise `File.Save`
 * makes: a temporary beside it, renamed over, so a failure leaves whatever was
 * there.
 */
static JSValue entries_install(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    const char *id = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!id)
        return JS_ThrowTypeError(ctx,
            "Desktop.Entries.Install(id, entry) needs an id");
    if (!entries_id(ctx, id, "Desktop.Entries.Install")) {
        JS_FreeCString(ctx, id);
        return JS_EXCEPTION;
    }
    if (argc < 2 || !JS_IsObject(argv[1])) {
        JS_FreeCString(ctx, id);
        return JS_ThrowTypeError(ctx,
            "Desktop.Entries.Install(id, entry) needs the entry as an object");
    }

    GKeyFile        *kf    = g_key_file_new();
    JSPropertyEnum  *groups = NULL;
    uint32_t         ngroups = 0;
    JSValue          err    = JS_UNDEFINED;

    if (JS_GetOwnPropertyNames(ctx, &groups, &ngroups, argv[1],
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
        g_key_file_free(kf);
        JS_FreeCString(ctx, id);
        return JS_EXCEPTION;
    }

    for (uint32_t g = 0; g < ngroups && !JS_IsException(err); g++) {
        const char *group = JS_AtomToCString(ctx, groups[g].atom);
        JSValue     body  = JS_GetProperty(ctx, argv[1], groups[g].atom);

        if (!group) {
            JS_FreeValue(ctx, body);
            err = JS_EXCEPTION;
            break;
        }
        if (!JS_IsObject(body)) {
            err = JS_ThrowTypeError(ctx,
                "Desktop.Entries.Install: [%s] is not an object of keys", group);
        } else {
            JSPropertyEnum *keys = NULL;
            uint32_t        nkeys = 0;

            if (JS_GetOwnPropertyNames(ctx, &keys, &nkeys, body,
                                       JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
                err = JS_EXCEPTION;
            } else {
                for (uint32_t k = 0; k < nkeys; k++) {
                    const char *key = JS_AtomToCString(ctx, keys[k].atom);
                    JSValue     val = JS_GetProperty(ctx, body, keys[k].atom);
                    const char *text = JS_IsString(val)
                                           ? JS_ToCString(ctx, val) : NULL;

                    if (!key || !text) {
                        err = JS_ThrowTypeError(ctx,
                            "Desktop.Entries.Install: %s in [%s] must be text",
                            key ? key : "a key", group);
                        JS_FreeCString(ctx, key);
                        JS_FreeCString(ctx, text);
                        JS_FreeValue(ctx, val);
                        break;
                    }
                    g_key_file_set_string(kf, group, key, text);
                    JS_FreeCString(ctx, key);
                    JS_FreeCString(ctx, text);
                    JS_FreeValue(ctx, val);
                }
                JS_FreePropertyEnum(ctx, keys, nkeys);
            }
        }
        JS_FreeCString(ctx, group);
        JS_FreeValue(ctx, body);
    }
    JS_FreePropertyEnum(ctx, groups, ngroups);

    if (JS_IsException(err)) {
        g_key_file_free(kf);
        JS_FreeCString(ctx, id);
        return err;
    }

    const char *group = "Desktop Entry";
    if (!g_key_file_has_group(kf, group) ||
        !g_key_file_has_key(kf, group, "Type", NULL) ||
        !g_key_file_has_key(kf, group, "Name", NULL)) {
        g_key_file_free(kf);
        JSValue e = JS_ThrowTypeError(ctx,
            "Desktop.Entries.Install: an entry needs a [%s] group with Type and Name",
            group);
        JS_FreeCString(ctx, id);
        return e;
    }

    char *type = g_key_file_get_string(kf, group, "Type", NULL);
    bool  app  = g_strcmp0(type, "Application") == 0;

    g_free(type);
    if (app && !g_key_file_has_key(kf, group, "Exec", NULL)) {
        g_key_file_free(kf);
        JSValue e = JS_ThrowTypeError(ctx,
            "Desktop.Entries.Install: an application needs an Exec");
        JS_FreeCString(ctx, id);
        return e;
    }

    char  *path = entries_path(id);
    char  *dir  = entries_dir();
    gsize  len  = 0;
    gchar *text = g_key_file_to_data(kf, &len, NULL);
    GError *error = NULL;

    g_mkdir_with_parents(dir, 0755);

    /* The serialised key file lives in memory, so it cannot outgrow G_MAXSSIZE;
     * the cast is for the signedness of the length the write takes. */
    if (!g_file_set_contents(path, text, (gssize)len, &error)) {
        JSValue e = JS_ThrowInternalError(ctx, "cannot write %s: %s", path,
                                          error ? error->message : "unknown error");
        g_clear_error(&error);
        g_free(text);
        g_free(dir);
        g_free(path);
        g_key_file_free(kf);
        JS_FreeCString(ctx, id);
        return e;
    }

    g_free(text);
    g_free(dir);
    g_key_file_free(kf);

    JSValue answer = JS_NewString(ctx, path);
    g_free(path);
    JS_FreeCString(ctx, id);
    return answer;
}

/* ----------------------------------------------------------------- Uninstall
 *
 * `Desktop.Entries.Uninstall(id)` -- removes that entry, answering whether
 * there was one.  Absent is `false` and not an error, for the same reason
 * `Read` answers `null`: asking about an entry that is already gone is how a
 * caller finds out.  A file that is there and cannot be removed throws, because
 * that failure leaves the menu unchanged and nobody would know.
 */
static JSValue entries_uninstall(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    const char *id = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;
    if (!id)
        return JS_ThrowTypeError(ctx,
            "Desktop.Entries.Uninstall(id) needs an id");
    if (!entries_id(ctx, id, "Desktop.Entries.Uninstall")) {
        JS_FreeCString(ctx, id);
        return JS_EXCEPTION;
    }

    char *path = entries_path(id);
    JSValue out;

    if (!g_file_test(path, G_FILE_TEST_EXISTS)) {
        out = JS_FALSE;
    } else if (g_remove(path) != 0) {
        out = JS_ThrowInternalError(ctx, "cannot remove %s", path);
    } else {
        out = JS_TRUE;
    }

    g_free(path);
    JS_FreeCString(ctx, id);
    return out;
}

/* ----------------------------------------------------------------- Installed
 *
 * `Desktop.Entries.Installed()` -- the ids of the entries this user has, sorted,
 * which is the question an application asks to find out whether it is installed
 * and the one a dialog offers to remove.  Ids and not the entries themselves:
 * `Read` answers what one says, and a caller that wants all of them walks this.
 *
 * Only the user's own directory is listed.  A system entry under
 * `/usr/share/applications` is the packager's and not this object's -- the
 * desktop merges the two when it draws a menu, and that merge is the desktop's.
 */
static JSValue entries_installed(JSContext *ctx, JSValueConst this_val,
                                 int argc, JSValueConst *argv)
{
    char        *dir   = entries_dir();
    GPtrArray   *names = g_ptr_array_new_with_free_func(g_free);
    GError      *error = NULL;
    GDir        *at    = g_dir_open(dir, 0, &error);
    const char  *name;

    if (!at) {
        /* A directory that is not there is no entries; one that is there and
         * cannot be read is a fault, and saying which is which is what keeps a
         * permission problem from reading as "nothing installed". */
        JSValue out;
        if (g_file_test(dir, G_FILE_TEST_IS_DIR))
            out = JS_ThrowInternalError(ctx, "cannot list %s: %s", dir,
                                        error ? error->message : "unknown error");
        else
            out = JS_NewArray(ctx);

        g_clear_error(&error);
        g_free(dir);
        return out;
    }

    while ((name = g_dir_read_name(at))) {
        char *path;
        char *id;

        if (name[0] == '.' || !g_str_has_suffix(name, ".desktop"))
            continue;

        path = g_build_filename(dir, name, NULL);
        if (!g_file_test(path, G_FILE_TEST_IS_REGULAR)) {
            g_free(path);
            continue;
        }
        g_free(path);

        id = g_strndup(name, strlen(name) - strlen(".desktop"));
        g_ptr_array_add(names, id);
    }
    g_dir_close(at);
    g_ptr_array_sort_values(names, (GCompareFunc)g_strcmp0);

    JSValue arr = JS_NewArray(ctx);
    for (guint i = 0; i < names->len; i++)
        JS_SetPropertyUint32(ctx, arr, i, JS_NewString(ctx, names->pdata[i]));

    g_ptr_array_unref(names);
    g_free(dir);
    return arr;
}

/* ---------------------------------------------------------------------- init */

void bta_desktop_init(JSContext *ctx, JSValue global)
{
    /*
     * The applications directory is made here, once, for the reason
     * `Application.ConfigDirectory` is: an application that installs an entry
     * should not have to create the place entries live -- and one that only
     * lists them should not have to guess whether an empty answer means an
     * empty menu or a missing directory.
     *
     * Failure is not fatal.  A machine where `~/.local/share` cannot be made is
     * one where `Install` will say so with the path in the message; it is not a
     * reason for every program that never touches an entry to fail at startup.
     */
    char *dir = entries_dir();
    g_mkdir_with_parents(dir, 0755);

    JSValue entries = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, entries, "Directory", JS_NewString(ctx, dir));
    JS_SetPropertyStr(ctx, entries, "Exec",
                      JS_NewCFunction(ctx, entries_exec, "Exec", 1));
    JS_SetPropertyStr(ctx, entries, "Installed",
                      JS_NewCFunction(ctx, entries_installed, "Installed", 0));
    JS_SetPropertyStr(ctx, entries, "Read",
                      JS_NewCFunction(ctx, entries_read, "Read", 1));
    JS_SetPropertyStr(ctx, entries, "Install",
                      JS_NewCFunction(ctx, entries_install, "Install", 2));
    JS_SetPropertyStr(ctx, entries, "Uninstall",
                      JS_NewCFunction(ctx, entries_uninstall, "Uninstall", 1));
    g_free(dir);

    JSValue desktop = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, desktop, "DataDirectory",
                      JS_NewString(ctx, g_get_user_data_dir()));
    JS_SetPropertyStr(ctx, desktop, "ConfigDirectory",
                      JS_NewString(ctx, g_get_user_config_dir()));
    JS_SetPropertyStr(ctx, desktop, "CacheDirectory",
                      JS_NewString(ctx, g_get_user_cache_dir()));
    JS_SetPropertyStr(ctx, desktop, "Entries", entries);
    JS_SetPropertyStr(ctx, global, "Desktop", desktop);
}
