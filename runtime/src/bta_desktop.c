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

#ifdef G_OS_WIN32
#include "bta_notification_win32.h"
#endif

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
            out = JS_ThrowPlainError(ctx, "cannot read %s: %s", path,
                                     bta_gerror_text(err));
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
                    out = JS_ThrowPlainError(ctx, "cannot read %s: %s", path,
                                             bta_gerror_text(err));
                    g_clear_error(&err);
                    JS_FreeValue(ctx, group);
                    break;
                }
                for (gsize k = 0; k < n; k++) {
                    gchar *val = g_key_file_get_string(kf, groups[i], keys[k], &err);

                    if (!val) {
                        JS_FreeValue(ctx, out);
                        out = JS_ThrowPlainError(ctx,
                            "cannot read %s: %s in [%s]", path,
                            err ? bta_gerror_text(err) : "invalid value", groups[i]);
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
/* The body both verbs share: serialise the entry, refuse what is not one, and
 * write it atomically at `path`.  `who` names the caller in every sentence --
 * the two verbs differ in where they write and not in what they accept. */
static JSValue entry_write_file(JSContext *ctx, const char *path,
                                JSValueConst entry, const char *who)
{
    GKeyFile        *kf    = g_key_file_new();
    JSPropertyEnum  *groups = NULL;
    uint32_t         ngroups = 0;
    JSValue          err    = JS_UNDEFINED;

    if (JS_GetOwnPropertyNames(ctx, &groups, &ngroups, entry,
                               JS_GPN_STRING_MASK | JS_GPN_ENUM_ONLY) < 0) {
        g_key_file_free(kf);
        return JS_EXCEPTION;
    }

    for (uint32_t g = 0; g < ngroups && !JS_IsException(err); g++) {
        const char *group = JS_AtomToCString(ctx, groups[g].atom);
        JSValue     body  = JS_GetProperty(ctx, entry, groups[g].atom);

        if (!group) {
            JS_FreeValue(ctx, body);
            err = JS_EXCEPTION;
            break;
        }
        if (!JS_IsObject(body)) {
            err = JS_ThrowTypeError(ctx,
                "%s: [%s] is not an object of keys", who, group);
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
                            "%s: %s in [%s] must be text",
                            who, key ? key : "a key", group);
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
        return err;
    }

    const char *group = "Desktop Entry";
    if (!g_key_file_has_group(kf, group) ||
        !g_key_file_has_key(kf, group, "Type", NULL) ||
        !g_key_file_has_key(kf, group, "Name", NULL)) {
        g_key_file_free(kf);
        return JS_ThrowTypeError(ctx,
            "%s: an entry needs a [%s] group with Type and Name", who, group);
    }

    char *type = g_key_file_get_string(kf, group, "Type", NULL);
    bool  app  = g_strcmp0(type, "Application") == 0;

    g_free(type);
    if (app && !g_key_file_has_key(kf, group, "Exec", NULL)) {
        g_key_file_free(kf);
        return JS_ThrowTypeError(ctx,
            "%s: an application needs an Exec", who);
    }

    char  *dir  = g_path_get_dirname(path);
    gsize  len  = 0;
    gchar *text = g_key_file_to_data(kf, &len, NULL);
    GError *error = NULL;

    g_mkdir_with_parents(dir, 0755);

    /* The serialised key file lives in memory, so it cannot outgrow G_MAXSSIZE;
     * the cast is for the signedness of the length the write takes. */
    if (!g_file_set_contents(path, text, (gssize)len, &error)) {
        JSValue e = JS_ThrowPlainError(ctx, "cannot write %s: %s", path,
                                       bta_gerror_text(error));
        g_clear_error(&error);
        g_free(text);
        g_free(dir);
        g_key_file_free(kf);
        return e;
    }

    g_free(text);
    g_free(dir);
    g_key_file_free(kf);
    return JS_UNDEFINED;
}

/*
 * `Desktop.Entries.Install(id, entry)` -- writes `Directory/<id>.desktop` and
 * answers the path it wrote.
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

    char   *path = entries_path(id);
    JSValue made = entry_write_file(ctx, path, argv[1],
                                    "Desktop.Entries.Install");
    JS_FreeCString(ctx, id);
    if (JS_IsException(made)) {
        g_free(path);
        return made;
    }

    JSValue answer = JS_NewString(ctx, path);
    g_free(path);
    return answer;
}

/*
 * `Desktop.Entries.Write(path, entry)` -- the same entry, at a path the caller
 * names, which is what a packaging step needs: the entry a package installs is
 * not one this user's menu has, and `Install` writes to the one place a menu
 * reads.  The directory is made when it is not there, the same way `Install`
 * makes its own, so a caller writing into a staging tree does not have to.
 */
static JSValue entries_write(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    if (argc < 2 || !JS_IsString(argv[0]) || !JS_IsObject(argv[1]))
        return JS_ThrowTypeError(ctx, "Desktop.Entries.Write(path, entry) needs "
                                      "the path and the entry as an object");

    const char *path = JS_ToCString(ctx, argv[0]);
    if (!path)
        return JS_EXCEPTION;

    JSValue made = entry_write_file(ctx, path, argv[1],
                                    "Desktop.Entries.Write");
    JS_FreeCString(ctx, path);
    return made;
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
        out = JS_ThrowPlainError(ctx, "cannot remove %s", path);
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
            out = JS_ThrowPlainError(ctx, "cannot list %s: %s", dir,
                                     bta_gerror_text(error));
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

/* --------------------------------------------------------------- Shortcut
 *
 * A user application is a menu entry on every platform; the shape of the
 * entry is not.  Linux has a `.desktop` file and `Desktop.Entries` owns it.
 * Windows has a `.lnk` in the user's Start Menu, whose AppUserModelID is what
 * ties the shortcut, the running process and its toasts together -- the exact
 * name `Notification` already had to register.  This object is that half:
 * `Available` says whether the platform has it, and the verbs refuse rather
 * than write a `.desktop` nobody reads.
 *
 * **The metadata is a sidecar, not a parsed `.lnk`.**  `IShellLinkW` can read
 * a shortcut back, but doing it for a list means COM, `IPropertyStore` and a
 * per-file round trip; a small key file beside the `.lnk` is the IDE's record
 * of what it installed, and `Installed()` is a directory listing.  A shortcut
 * some other program wrote is not this object's to list or remove.
 */
static char *shortcut_dir(void)
{
#ifdef G_OS_WIN32
    const char *roaming = g_getenv("APPDATA");

    if (!roaming || !*roaming)
        roaming = g_get_user_data_dir();
    return g_build_filename(roaming, "Microsoft", "Windows", "Start Menu",
                            "Programs", "Bintana", NULL);
#else
    return NULL;
#endif
}

/* The record of what was installed lives outside the Start Menu: a `.shortcut`
 * beside its `.lnk` would be a second, unexplained file in a folder the user
 * opens. */
static char *shortcut_meta_dir(void)
{
#ifdef G_OS_WIN32
    const char *roaming = g_getenv("APPDATA");

    if (!roaming || !*roaming)
        roaming = g_get_user_data_dir();
    return g_build_filename(roaming, "Bintana", "apps", NULL);
#else
    return NULL;
#endif
}

static char *shortcut_path(const char *dir, const char *id, const char *suffix)
{
    char *name = g_strconcat(id, suffix, NULL);
    char *path = g_build_filename(dir, name, NULL);

    g_free(name);
    return path;
}

static bool shortcut_id(JSContext *ctx, const char *id, const char *who)
{
    if (!entries_id(ctx, id, who))
        return false;

    if (g_str_has_suffix(id, ".lnk") || g_str_has_suffix(id, ".shortcut")) {
        JS_ThrowTypeError(ctx, "%s: \"%s\" is a file name, not an id", who, id);
        return false;
    }
    return true;
}

#ifdef G_OS_WIN32
static bool shortcut_text(JSContext *ctx, JSValueConst entry, const char *key,
                          bool required, char **out, const char *who)
{
    JSValue v = JS_GetPropertyStr(ctx, entry, key);

    *out = NULL;
    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        JS_FreeValue(ctx, v);
        if (required)
            JS_ThrowTypeError(ctx, "%s: %s is required", who, key);
        return !required;
    }
    if (!JS_IsString(v)) {
        JS_FreeValue(ctx, v);
        JS_ThrowTypeError(ctx, "%s: %s is text", who, key);
        return false;
    }

    const char *text = JS_ToCString(ctx, v);
    JS_FreeValue(ctx, v);
    if (!text)
        return false;
    *out = g_strdup(text);
    JS_FreeCString(ctx, text);
    return true;
}

/* A Windows command line: every argument quoted the way CommandLineToArgvW
 * reads it back, so a project path with a space is one argument. */
static void shortcut_quote_arg(GString *out, const char *arg)
{
    bool        quote = *arg == '\0' || strpbrk(arg, " \t\"") != NULL;
    const char *p     = arg;

    if (quote)
        g_string_append_c(out, '"');

    while (*p) {
        size_t slashes = 0;

        while (*p == '\\') {
            slashes++;
            p++;
        }
        if (*p == '"') {
            for (size_t i = 0; i < slashes * 2 + 1; i++)
                g_string_append_c(out, '\\');
            g_string_append_c(out, '"');
            p++;
        } else {
            for (size_t i = 0; i < slashes; i++)
                g_string_append_c(out, '\\');
            if (*p)
                g_string_append_c(out, *p++);
        }
    }

    if (quote) {
        size_t trailing = 0;

        for (const char *q = arg + strlen(arg); q > arg && q[-1] == '\\'; q--)
            trailing++;
        for (size_t i = 0; i < trailing; i++)
            g_string_append_c(out, '\\');
        g_string_append_c(out, '"');
    }
}

static bool shortcut_arguments(JSContext *ctx, JSValueConst entry,
                               char ***list, char **command, const char *who)
{
    JSValue v = JS_GetPropertyStr(ctx, entry, "Arguments");

    *list    = NULL;
    *command = NULL;
    if (JS_IsUndefined(v) || JS_IsNull(v)) {
        JS_FreeValue(ctx, v);
        return true;
    }
    if (!JS_IsArray(v)) {
        JS_FreeValue(ctx, v);
        JS_ThrowTypeError(ctx, "%s: Arguments is an array", who);
        return false;
    }

    JSValue length = JS_GetPropertyStr(ctx, v, "length");
    uint32_t n = 0;

    if (JS_ToUint32(ctx, &n, length)) {
        JS_FreeValue(ctx, length);
        JS_FreeValue(ctx, v);
        return false;
    }
    JS_FreeValue(ctx, length);

    GPtrArray *args = g_ptr_array_new_with_free_func(g_free);
    GString   *cmd  = g_string_new(NULL);

    for (uint32_t i = 0; i < n; i++) {
        JSValue item = JS_GetPropertyUint32(ctx, v, i);

        if (!JS_IsString(item)) {
            JS_FreeValue(ctx, item);
            g_ptr_array_unref(args);
            g_string_free(cmd, TRUE);
            JS_FreeValue(ctx, v);
            JS_ThrowTypeError(ctx, "%s: Arguments[%u] is text", who, i);
            return false;
        }
        const char *text = JS_ToCString(ctx, item);

        JS_FreeValue(ctx, item);
        if (!text) {
            g_ptr_array_unref(args);
            g_string_free(cmd, TRUE);
            JS_FreeValue(ctx, v);
            return false;
        }
        if (i)
            g_string_append_c(cmd, ' ');
        shortcut_quote_arg(cmd, text);
        g_ptr_array_add(args, g_strdup(text));
        JS_FreeCString(ctx, text);
    }
    JS_FreeValue(ctx, v);

    *list = g_new0(char *, args->len + 1);
    for (guint i = 0; i < args->len; i++)
        (*list)[i] = g_strdup(args->pdata[i]);
    g_ptr_array_unref(args);
    *command = g_string_free(cmd, FALSE);
    return true;
}

static char *shortcut_gui_target(const char *target)
{
    char *chosen = g_strdup(target && *target ? target : bta_exe_path());

    if (!chosen)
        return NULL;

    char *dir = g_path_get_dirname(chosen);
    char *gui = g_build_filename(dir, "bintanaw.exe", NULL);

    if (g_file_test(gui, G_FILE_TEST_EXISTS) &&
        g_str_has_suffix(chosen, "bintana.exe")) {
        g_free(chosen);
        chosen = gui;
    } else {
        g_free(gui);
    }
    g_free(dir);
    return chosen;
}

static bool shortcut_write_meta(const char *path, const char *name,
                                const char *project, const char *target,
                                char **args, guint n_args, const char *icon,
                                const char *description, const char *appid,
                                GError **error)
{
    GKeyFile *kf = g_key_file_new();

    g_key_file_set_string(kf, "Shortcut", "Name", name);
    g_key_file_set_string(kf, "Shortcut", "Project", project);
    g_key_file_set_string(kf, "Shortcut", "Target", target);
    g_key_file_set_string(kf, "Shortcut", "AppId", appid);
    if (icon && *icon)
        g_key_file_set_string(kf, "Shortcut", "Icon", icon);
    if (description && *description)
        g_key_file_set_string(kf, "Shortcut", "Description", description);
    if (n_args)
        g_key_file_set_string_list(kf, "Shortcut", "Arguments",
                                   (const gchar * const *)args, n_args);

    gsize len = 0;
    char *data = g_key_file_to_data(kf, &len, error);

    g_key_file_free(kf);
    if (!data)
        return false;

    bool ok = g_file_set_contents(path, data, len, error);

    g_free(data);
    return ok;
}
#endif /* G_OS_WIN32 */

static JSValue shortcut_installed(JSContext *ctx, JSValueConst this_val,
                                  int argc, JSValueConst *argv)
{
    char        *dir   = shortcut_meta_dir();
    GPtrArray   *names = g_ptr_array_new_with_free_func(g_free);
    GError      *error = NULL;
    GDir        *at    = dir ? g_dir_open(dir, 0, &error) : NULL;
    const char  *name;

    if (!at) {
        JSValue out;
        if (dir && g_file_test(dir, G_FILE_TEST_IS_DIR))
            out = JS_ThrowPlainError(ctx, "cannot list %s: %s", dir,
                                     bta_gerror_text(error));
        else
            out = JS_NewArray(ctx);

        g_clear_error(&error);
        g_free(dir);
        g_ptr_array_unref(names);
        return out;
    }

    while ((name = g_dir_read_name(at))) {
        if (name[0] == '.' || !g_str_has_suffix(name, ".shortcut"))
            continue;
        g_ptr_array_add(names,
                        g_strndup(name, strlen(name) - strlen(".shortcut")));
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

static JSValue shortcut_read(JSContext *ctx, JSValueConst this_val,
                             int argc, JSValueConst *argv)
{
    const char *id = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;

    if (!id)
        return JS_ThrowTypeError(ctx, "Desktop.Shortcut.Read(id) needs an id");
    if (!shortcut_id(ctx, id, "Desktop.Shortcut.Read")) {
        JS_FreeCString(ctx, id);
        return JS_EXCEPTION;
    }

    char *dir = shortcut_meta_dir();
    if (!dir) {
        JS_FreeCString(ctx, id);
        return JS_NULL;
    }

    char     *meta = shortcut_path(dir, id, ".shortcut");
    GKeyFile *kf   = g_key_file_new();
    JSValue   out  = JS_NULL;

    if (g_key_file_load_from_file(kf, meta, G_KEY_FILE_NONE, NULL)) {
        out = JS_NewObject(ctx);

        char *name = g_key_file_get_string(kf, "Shortcut", "Name", NULL);
        char *project = g_key_file_get_string(kf, "Shortcut", "Project", NULL);
        char *target = g_key_file_get_string(kf, "Shortcut", "Target", NULL);
        char *icon = g_key_file_get_string(kf, "Shortcut", "Icon", NULL);
        char *description = g_key_file_get_string(kf, "Shortcut", "Description", NULL);
        char *appid = g_key_file_get_string(kf, "Shortcut", "AppId", NULL);
        char **args = g_key_file_get_string_list(kf, "Shortcut", "Arguments",
                                                NULL, NULL);

        JS_SetPropertyStr(ctx, out, "Id", JS_NewString(ctx, id));
        JS_SetPropertyStr(ctx, out, "Name", JS_NewString(ctx, name ? name : ""));
        JS_SetPropertyStr(ctx, out, "Project", JS_NewString(ctx, project ? project : ""));
        JS_SetPropertyStr(ctx, out, "Target", JS_NewString(ctx, target ? target : ""));
        JS_SetPropertyStr(ctx, out, "Icon", JS_NewString(ctx, icon ? icon : ""));
        JS_SetPropertyStr(ctx, out, "Description",
                          JS_NewString(ctx, description ? description : ""));
        /* `Comment` is the name the desktop entry uses and what AppForm reads. */
        JS_SetPropertyStr(ctx, out, "Comment",
                          JS_NewString(ctx, description ? description : ""));
        JS_SetPropertyStr(ctx, out, "AppId", JS_NewString(ctx, appid ? appid : ""));

        JSValue list = JS_NewArray(ctx);
        for (gsize i = 0; args && args[i]; i++)
            JS_SetPropertyUint32(ctx, list, i, JS_NewString(ctx, args[i]));
        JS_SetPropertyStr(ctx, out, "Arguments", list);

        g_strfreev(args);
        g_free(name);
        g_free(project);
        g_free(target);
        g_free(icon);
        g_free(description);
        g_free(appid);
    }

    g_key_file_free(kf);
    g_free(meta);
    g_free(dir);
    JS_FreeCString(ctx, id);
    return out;
}

static JSValue shortcut_write(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    const char *id = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;

    if (!id)
        return JS_ThrowTypeError(ctx,
            "Desktop.Shortcut.Write(id, entry) needs an id");
    if (!shortcut_id(ctx, id, "Desktop.Shortcut.Write")) {
        JS_FreeCString(ctx, id);
        return JS_EXCEPTION;
    }
    if (argc < 2 || !JS_IsObject(argv[1])) {
        JS_FreeCString(ctx, id);
        return JS_ThrowTypeError(ctx,
            "Desktop.Shortcut.Write(id, entry) needs the entry as an object");
    }

#ifdef G_OS_WIN32
    const char *who = "Desktop.Shortcut.Write";
    char *name = NULL, *project = NULL, *target = NULL;
    char *icon = NULL, *description = NULL, *appid = NULL;
    char **args = NULL, *command = NULL;
    JSValue result = JS_EXCEPTION;

    if (!shortcut_text(ctx, argv[1], "Name", true, &name, who) ||
        !shortcut_text(ctx, argv[1], "Project", true, &project, who) ||
        !shortcut_text(ctx, argv[1], "Target", false, &target, who) ||
        !shortcut_text(ctx, argv[1], "Icon", false, &icon, who) ||
        !shortcut_text(ctx, argv[1], "Description", false, &description, who) ||
        !shortcut_text(ctx, argv[1], "AppId", false, &appid, who) ||
        !shortcut_arguments(ctx, argv[1], &args, &command, who))
        goto done;

    if (!*name || !*project) {
        JS_ThrowTypeError(ctx, "%s: Name and Project are not empty", who);
        goto done;
    }

    char *gui = shortcut_gui_target(target);
    if (!gui) {
        JS_ThrowPlainError(ctx, "%s: no target executable", who);
        goto done;
    }

    char *dir = shortcut_dir();
    char *meta_dir = shortcut_meta_dir();

    if (!dir || !meta_dir) {
        JS_ThrowPlainError(ctx, "%s: no Start Menu directory", who);
        g_free(gui);
        g_free(dir);
        g_free(meta_dir);
        goto done;
    }
    if (g_mkdir_with_parents(dir, 0755) != 0) {
        JS_ThrowPlainError(ctx, "%s: cannot create %s", who, dir);
        g_free(gui);
        g_free(dir);
        g_free(meta_dir);
        goto done;
    }
    if (g_mkdir_with_parents(meta_dir, 0755) != 0) {
        JS_ThrowPlainError(ctx, "%s: cannot create %s", who, meta_dir);
        g_free(gui);
        g_free(dir);
        g_free(meta_dir);
        goto done;
    }

    char *lnk  = shortcut_path(dir, id, ".lnk");
    char *meta = shortcut_path(meta_dir, id, ".shortcut");
    char *shown_icon = NULL;

    /* A `.ico` (or an executable/dll with icons) is what IShellLinkW can wear;
     * a `.png`, a theme name or a path that is not there leaves the target's
     * own icon.  `Apps` turns a project's PNG into the `.ico`. */
    if (icon && *icon && g_file_test(icon, G_FILE_TEST_EXISTS) &&
        (g_str_has_suffix(icon, ".ico") || g_str_has_suffix(icon, ".exe") ||
         g_str_has_suffix(icon, ".dll")))
        shown_icon = g_strdup(icon);

    const char *aumid = appid && *appid ? appid : id;

    if (!bta_shortcut_win32_write(lnk, gui, command, project, shown_icon,
                                  description, aumid)) {
        JS_ThrowPlainError(ctx, "%s: cannot write %s", who, lnk);
        g_free(shown_icon);
        g_free(lnk);
        g_free(meta);
        g_free(dir);
        g_free(meta_dir);
        g_free(gui);
        goto done;
    }

    GError *error = NULL;
    guint n_args = args ? g_strv_length(args) : 0;

    if (!shortcut_write_meta(meta, name, project, gui, args, n_args,
                             shown_icon, description, aumid, &error)) {
        g_remove(lnk);
        JS_ThrowPlainError(ctx, "%s: cannot write %s: %s", who, meta,
                           bta_gerror_text(error));
        g_clear_error(&error);
        g_free(shown_icon);
        g_free(lnk);
        g_free(meta);
        g_free(dir);
        g_free(meta_dir);
        g_free(gui);
        goto done;
    }

    result = JS_NewString(ctx, lnk);
    g_free(shown_icon);
    g_free(lnk);
    g_free(meta);
    g_free(dir);
    g_free(meta_dir);
    g_free(gui);

done:
    g_free(name);
    g_free(project);
    g_free(target);
    g_free(icon);
    g_free(description);
    g_free(appid);
    g_strfreev(args);
    g_free(command);
    JS_FreeCString(ctx, id);
    return result;
#else
    JS_FreeCString(ctx, id);
    return JS_ThrowPlainError(ctx,
        "Desktop.Shortcut.Write is Windows-only; Desktop.Entries is the Linux one");
#endif
}

static JSValue shortcut_remove(JSContext *ctx, JSValueConst this_val,
                               int argc, JSValueConst *argv)
{
    const char *id = argc > 0 ? JS_ToCString(ctx, argv[0]) : NULL;

    if (!id)
        return JS_ThrowTypeError(ctx,
            "Desktop.Shortcut.Remove(id) needs an id");
    if (!shortcut_id(ctx, id, "Desktop.Shortcut.Remove")) {
        JS_FreeCString(ctx, id);
        return JS_EXCEPTION;
    }

    char *dir = shortcut_dir();
    char *meta_dir = shortcut_meta_dir();
    if (!dir || !meta_dir) {
        g_free(dir);
        g_free(meta_dir);
        JS_FreeCString(ctx, id);
        return JS_FALSE;
    }

    char  *lnk  = shortcut_path(dir, id, ".lnk");
    char  *meta = shortcut_path(meta_dir, id, ".shortcut");
    bool   had  = g_file_test(lnk, G_FILE_TEST_EXISTS) ||
                  g_file_test(meta, G_FILE_TEST_EXISTS);
    JSValue out = JS_NewBool(ctx, had);

    if (g_file_test(lnk, G_FILE_TEST_EXISTS) && g_remove(lnk) != 0)
        out = JS_ThrowPlainError(ctx, "cannot remove %s", lnk);
    else if (g_file_test(meta, G_FILE_TEST_EXISTS) && g_remove(meta) != 0)
        out = JS_ThrowPlainError(ctx, "cannot remove %s", meta);

    g_free(lnk);
    g_free(meta);
    g_free(dir);
    g_free(meta_dir);
    JS_FreeCString(ctx, id);
    return out;
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
    /* Directory
     *   `DataDirectory/applications`, created on first use. Write an entry
     *   there and the desktop's menu offers it; there is nothing to register
     *   and no index to update
     */
    JS_SetPropertyStr(ctx, entries, "Directory", JS_NewString(ctx, dir));
    /* Exec(argv) -> string
     *   the value for the `Exec` key: the arguments as an array — the shape
     *   `Exec` and `Terminal.Run` already take — quoted and escaped the
     *   format's way
     */
    JS_SetPropertyStr(ctx, entries, "Exec",
                      JS_NewCFunction(ctx, entries_exec, "Exec", 1));
    /* Installed() -> string[]
     *   the ids in `Directory`, sorted, `.desktop` removed. Only this user's:
     *   a system entry is never listed, and asking whether an entry is
     *   installed is one `includes` on this
     */
    JS_SetPropertyStr(ctx, entries, "Installed",
                      JS_NewCFunction(ctx, entries_installed, "Installed", 0));
    /* Read(id)
     *   one entry as data, exactly what `Install` takes, or `null` when there
     *   is no such file
     */
    JS_SetPropertyStr(ctx, entries, "Read",
                      JS_NewCFunction(ctx, entries_read, "Read", 1));
    /* Install(id, entry) -> string
     *   writes `Directory/<id>.desktop` and answers the path. Atomic — a
     *   temporary beside it, renamed over — so a failure leaves whatever was
     *   there
     */
    JS_SetPropertyStr(ctx, entries, "Install",
                      JS_NewCFunction(ctx, entries_install, "Install", 2));
    /* Write(path, entry)
     *   the same entry and the same checks at a path the caller names,
     *   **making the directory** when it is not there. For the entry a
     *   package installs, which is not one this user's menu has; answers
     *   nothing
     */
    JS_SetPropertyStr(ctx, entries, "Write",
                      JS_NewCFunction(ctx, entries_write, "Write", 2));
    /* Uninstall(id) -> boolean
     *   removes it, answering whether there was one. A file that is there and
     *   cannot be removed throws
     */
    JS_SetPropertyStr(ctx, entries, "Uninstall",
                      JS_NewCFunction(ctx, entries_uninstall, "Uninstall", 1));
    g_free(dir);

    /*
     * The Windows spelling of a user application: a `.lnk` in the Start Menu.
     * It is a separate object because the entry's shape is different -- a
     * target and an argv array, not a single `Exec` string -- and pretending
     * otherwise would make both platforms lie about one of them.
     */
    JSValue shortcut = JS_NewObject(ctx);
    char   *shortcut_root = shortcut_dir();

    bool shortcut_available = false;
#ifdef G_OS_WIN32
    shortcut_available = true;
#endif
    /* Available
     *   whether this platform installs a user application as a Start Menu
     *   shortcut: `true` on Windows, `false` everywhere else
     */
    JS_SetPropertyStr(ctx, shortcut, "Available",
                      JS_NewBool(ctx, shortcut_available));
    /* Directory
     *   the Start Menu folder the shortcuts live in, or `""` where this is not
     *   Windows. The folder is made by `Write`, not at startup
     */
    JS_SetPropertyStr(ctx, shortcut, "Directory",
                      JS_NewString(ctx, shortcut_root ? shortcut_root : ""));
    g_free(shortcut_root);
    /* Installed() -> string[]
     *   the ids installed by this object, sorted. A shortcut some other program
     *   wrote is not listed
     */
    JS_SetPropertyStr(ctx, shortcut, "Installed",
                      JS_NewCFunction(ctx, shortcut_installed, "Installed", 0));
    /* Read(id)
     *   `{ Id, Name, Project, Target, Arguments, Icon, Description, Comment,
     *   AppId }` for one installed shortcut, or `null`
     */
    JS_SetPropertyStr(ctx, shortcut, "Read",
                      JS_NewCFunction(ctx, shortcut_read, "Read", 1));
    /* Write(id, entry) -> string
     *   writes `Directory/<id>.lnk` with `System.AppUserModel.ID` and answers
     *   its path. `entry` is `{ Name, Project, Target, Arguments, Icon,
     *   Description, AppId }`: `Name` and `Project` are required, `Target`
     *   defaults to this runtime's GUI executable, `Arguments` is an array of
     *   strings, and `Icon` is a `.ico` (a `.png` is turned into one by the
     *   caller). **Windows only**: elsewhere it refuses, and
     *   `Desktop.Entries` is the road
     */
    JS_SetPropertyStr(ctx, shortcut, "Write",
                      JS_NewCFunction(ctx, shortcut_write, "Write", 2));
    /* Remove(id) -> boolean
     *   removes the shortcut and its record, answering whether either was
     *   there. A file that is there and cannot be removed throws
     */
    JS_SetPropertyStr(ctx, shortcut, "Remove",
                      JS_NewCFunction(ctx, shortcut_remove, "Remove", 1));

    JSValue desktop = JS_NewObject(ctx);
    /* DataDirectory
     *   `$XDG_DATA_HOME`, or `~/.local/share` when the desktop has not moved
     *   it. Application data that belongs to this user: a database, a saved
     *   document, an installed menu entry
     */
    JS_SetPropertyStr(ctx, desktop, "DataDirectory",
                      JS_NewString(ctx, g_get_user_data_dir()));
    /* ConfigDirectory
     *   `$XDG_CONFIG_HOME`, or `~/.config`. Settings, kept apart from data
     *   because a backup or a sync usually wants one and not the other
     */
    JS_SetPropertyStr(ctx, desktop, "ConfigDirectory",
                      JS_NewString(ctx, g_get_user_config_dir()));
    /* CacheDirectory
     *   `$XDG_CACHE_HOME`, or `~/.cache`. Anything that can be thrown away
     *   and rebuilt
     */
    JS_SetPropertyStr(ctx, desktop, "CacheDirectory",
                      JS_NewString(ctx, g_get_user_cache_dir()));
    /* Entries
     *   the module below
     */
    JS_SetPropertyStr(ctx, desktop, "Entries", entries);
    /* Shortcut
     *   the Windows `.lnk` object above; `Available` says whether it is there
     */
    JS_SetPropertyStr(ctx, desktop, "Shortcut", shortcut);
    JS_SetPropertyStr(ctx, global, "Desktop", desktop);
}
