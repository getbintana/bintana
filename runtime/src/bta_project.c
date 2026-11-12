/*
 * Reading a project: its manifest, its sources, and the libraries it names.
 *
 * This is the half of `bta_runtime.c`'s boot that never touches the toolkit,
 * in a file both hosts link. `bintana` uses it to decide what to load before a
 * window exists; `bintana-headless` uses the same functions to run a console
 * project and to find `tools/check`. One definition, so a library resolves the
 * same way in both and a source order cannot drift.
 */
#include "bta.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* The project directory a command-line argument names: the directory itself,
 * or the one a `project.btp` handed over as a file sits in. */
char *bta_project_dir(const char *path)
{
    char *dir = g_canonicalize_filename(path, NULL);

    if (g_file_test(dir, G_FILE_TEST_IS_REGULAR)) {
        char *parent = g_path_get_dirname(dir);

        g_free(dir);
        dir = parent;
    }
    return dir;
}

/*
 * The manifest's path: `project.btp`, the project's one name, and the old
 * `project.json` still read when it is the only one. The fallback is what lets
 * a tree written before the rename run without being touched; the IDE is where
 * one is migrated, and nothing new writes the old name.
 */
char *bta_project_manifest(const char *dir)
{
    char *path = g_build_filename(dir, "project.btp", NULL);

    if (g_file_test(path, G_FILE_TEST_IS_REGULAR))
        return path;

    g_free(path);
    return g_build_filename(dir, "project.json", NULL);
}

/* A string key out of a parsed manifest, or the fallback when it is absent or
 * is not text. */
char *bta_project_string(JSContext *ctx, JSValueConst obj, const char *key,
                         const char *fallback)
{
    JSValue v = JS_GetPropertyStr(ctx, obj, key);
    char   *out;

    if (JS_IsString(v)) {
        const char *s = JS_ToCString(ctx, v);
        out = g_strdup(s);
        JS_FreeCString(ctx, s);
    } else {
        out = g_strdup(fallback);
    }
    JS_FreeValue(ctx, v);
    return out;
}

/* Every .js under a directory, subdirectories included: a project is allowed to
 * organise its classes in folders, and one that lists no sources still means
 * "all of my code". */
/* `root` is the project directory: its `tests/` is `bintana test`'s and is
 * never loaded by a run, listed or not (see `Test` in rad.js). */
void bta_collect_js(GPtrArray *out, const char *dir, bool root)
{
    GDir *d = g_dir_open(dir, 0, NULL);
    if (!d)
        return;

    const char *name;
    while ((name = g_dir_read_name(d))) {
        if (name[0] == '.')
            continue;   /* .git and whatever else a project keeps to itself */
        if (root && g_str_equal(name, "tests"))
            continue;

        char *path = g_build_filename(dir, name, NULL);
        if (g_file_test(path, G_FILE_TEST_IS_DIR)) {
            bta_collect_js(out, path, false);
            g_free(path);
        } else if (g_str_has_suffix(name, ".js")) {
            g_ptr_array_add(out, path);
        } else {
            g_free(path);
        }
    }
    g_dir_close(d);
}

/*
 * ------------------------------------------------------------------ libraries
 *
 * `"uses": ["charts"]` in project.btp, and where a library by that name lives.
 *
 * **A library is a directory of `.js` and `.form` files.** No manifest, no
 * version, no dependency of its own: the thing a project is short of is a place
 * for shared *classes*, and a directory of them is the whole of what that takes.
 * Its sources load before the project's, and its forms are indexed with the
 * project's, which is what lets a `.form` say `"type": "Chart"` about a class
 * that is not in the project tree.
 *
 * **Six places, most specific first**, and the reason each is there:
 *
 *   <project>/lib/<name>            the project's own copy, or a private library
 *   $BINTANA_LIB_PATH (colon separated) developing a library outside any tree
 *   ~/.local/share/bintana/lib     installed for one person, without root
 *   <binary>/../lib                 **the source tree**, uninstalled
 *   <binary>/../share/bintana/lib  installed beside the binary
 *   /usr/share/bintana/lib         a distribution's, with the binary elsewhere
 *
 * The two that resolve from the binary are the same relative hop, and that is
 * deliberate: `bin/` and `share/bintana/` move together under `--prefix` and
 * under a packager's DESTDIR, where a path baked in at configure time does not.
 * It is the argument `tools/bintana-ide.in` already makes for the launcher, applied
 * inside the runtime -- and it is what makes `./build/bintana examples/charts` find
 * `lib/charts` in the source tree with nothing configured and nothing installed.
 *
 * The order follows the icon theme's, which this codebase already walks in
 * `tests/icons`: the user's own, then the system's. A library is data, and data
 * is looked up the way the desktop looks up data.
 */
void bta_library_candidates(const char *project, GPtrArray *out)
{
    if (project && *project)
        g_ptr_array_add(out, g_build_filename(project, "lib", NULL));

    const char *env = g_getenv("BINTANA_LIB_PATH");
    if (env && *env) {
        /* `G_SEARCHPATH_SEPARATOR` and not a colon: the variable holds paths,
         * and on Windows a path begins with `C:` -- splitting on the colon
         * there cuts the first one in two. */
        char **parts = g_strsplit(env, G_SEARCHPATH_SEPARATOR_S, -1);
        for (int i = 0; parts[i]; i++)
            if (*parts[i])
                g_ptr_array_add(out, g_strdup(parts[i]));
        g_strfreev(parts);
    }

    g_ptr_array_add(out, g_build_filename(g_get_user_data_dir(), "bintana",
                                          "lib", NULL));

    char *exe = bta_exe_path();
    if (exe) {
        char *bin = g_path_get_dirname(exe);
        char *up  = g_path_get_dirname(bin);

        g_ptr_array_add(out, g_build_filename(up, "lib", NULL));
        g_ptr_array_add(out, g_build_filename(up, "share", "bintana", "lib", NULL));
        g_free(up);
        g_free(bin);
        g_free(exe);
    }
    g_ptr_array_add(out, g_build_filename("/usr", "share", "bintana", "lib", NULL));
}

/* The directory, or NULL with `tried` filled in -- because a library that is not
 * there has to say where it was looked for, or the answer is unactionable. */
char *bta_library_resolve(const char *project, const char *name, GString *tried)
{
    GPtrArray *where = g_ptr_array_new_with_free_func(g_free);
    char      *found = NULL;

    bta_library_candidates(project, where);

    for (guint i = 0; i < where->len && !found; i++) {
        char *path = g_build_filename(g_ptr_array_index(where, i), name, NULL);

        if (g_file_test(path, G_FILE_TEST_IS_DIR))
            found = path;
        else {
            if (tried)
                g_string_append_printf(tried, "\n  %s", path);
            g_free(path);
        }
    }
    g_ptr_array_free(where, TRUE);
    return found;
}

/*
 * What "uses" named, resolved. A name that is not there **stops the program**:
 * a library whose classes half the forms refer to is not something to carry on
 * without, and the failure a moment later would be `unknown widget type 'Chart'`
 * with nothing about a missing library in it.
 */
GPtrArray *bta_project_libs(JSContext *ctx, const char *dir, JSValueConst cfg)
{
    GPtrArray *out = g_ptr_array_new_with_free_func(g_free);
    JSValue    arr = JS_GetPropertyStr(ctx, cfg, "uses");

    if (!JS_IsArray(arr)) {
        JS_FreeValue(ctx, arr);
        return out;
    }

    JSValue  lenv = JS_GetPropertyStr(ctx, arr, "length");
    uint32_t n    = 0;
    JS_ToUint32(ctx, &n, lenv);
    JS_FreeValue(ctx, lenv);

    for (uint32_t i = 0; i < n; i++) {
        JSValue     e    = JS_GetPropertyUint32(ctx, arr, i);
        const char *name = JS_ToCString(ctx, e);

        if (name && *name) {
            GString *tried = g_string_new(NULL);
            char    *lib   = bta_library_resolve(dir, name, tried);

            if (lib) {
                g_ptr_array_add(out, lib);
            } else {
                fprintf(stderr, "bintana: project.btp uses \"%s\", which is not "
                                "in any of:%s\n", name, tried->str);
                g_string_free(tried, TRUE);
                JS_FreeCString(ctx, name);
                JS_FreeValue(ctx, e);
                g_ptr_array_free(out, TRUE);
                JS_FreeValue(ctx, arr);
                exit(2);
            }
            g_string_free(tried, TRUE);
        }
        JS_FreeCString(ctx, name);
        JS_FreeValue(ctx, e);
    }
    JS_FreeValue(ctx, arr);
    return out;
}

/*
 * A library's own `.js`: the order it loads them on the main thread, and the
 * subset a `Task` worker may import.
 *
 * **A library may carry a `project.btp`, and two of its keys are read.**
 * `sources` orders the library's own files; one class needs no order and most
 * libraries will not have the file, but one whose classes extend each other
 * does -- `BarChart extends Chart` sorts the wrong way round by path, which is
 * the same reason a project has `sources` at all. `worker` names the files a
 * worker may import, for a library whose `sources` include a module that
 * extends `Component`; its absence keeps the old answer (the sources list,
 * with scripts skipped), and an empty list says there is no safe subset.
 * Reusing the names is the whole of the mechanism: anybody who has written a
 * project already knows them, and there is no second manifest format to learn
 * or to keep working.
 *
 * Nothing else in that file means anything here: a library is not a project and
 * `bintana <library>` is not a thing to do.
 *
 * One list at a time: NULL when the file is absent, cannot be read, is not
 * JSON, or `key` is not an array -- the caller decides what to fall back to.
 * An **empty array** is a real answer: the library declared no files for that
 * purpose.
 */
static GPtrArray *library_list(JSContext *ctx, const char *dir, const char *key)
{
    GPtrArray *out  = NULL;
    char      *path = bta_project_manifest(dir);
    char      *text = NULL;

    if (g_file_test(path, G_FILE_TEST_IS_REGULAR))
        text = bta_read_file(path, NULL);
    g_free(path);
    if (!text)
        return NULL;

    JSValue cfg = JS_ParseJSON(ctx, text, strlen(text), "library");

    if (JS_IsException(cfg)) {
        JS_FreeValue(ctx, JS_GetException(ctx));
        fprintf(stderr, "bintana: %s's project file is not JSON; loading its "
                        "files by path\n", dir);
    } else {
        JSValue arr = JS_GetPropertyStr(ctx, cfg, key);

        if (JS_IsArray(arr)) {
            JSValue  lenv = JS_GetPropertyStr(ctx, arr, "length");
            uint32_t n    = 0;

            JS_ToUint32(ctx, &n, lenv);
            JS_FreeValue(ctx, lenv);
            out = g_ptr_array_new_with_free_func(g_free);
            for (uint32_t i = 0; i < n; i++) {
                JSValue     e = JS_GetPropertyUint32(ctx, arr, i);
                const char *f = JS_ToCString(ctx, e);

                if (f && *f)
                    g_ptr_array_add(out, g_build_filename(dir, f, NULL));
                JS_FreeCString(ctx, f);
                JS_FreeValue(ctx, e);
            }
        }
        JS_FreeValue(ctx, arr);
        JS_FreeValue(ctx, cfg);
    }
    g_free(text);
    return out;
}

GPtrArray *bta_library_sources(JSContext *ctx, const char *dir)
{
    GPtrArray *out = library_list(ctx, dir, "sources");

    if (!out)
        out = g_ptr_array_new_with_free_func(g_free);

    /* No list, an empty one, or a file that would not parse: every `.js` in it,
     * sorted by path -- the same fallback and the same limit a project has. */
    if (out->len == 0) {
        bta_collect_js(out, dir, true);
        g_ptr_array_sort_values(out, (GCompareFunc)g_strcmp0);
    }
    return out;
}

GPtrArray *bta_library_worker_sources(JSContext *ctx, const char *dir)
{
    return library_list(ctx, dir, "worker");
}

/*
 * The files a project loads, in order.
 *
 * `sources` wins; otherwise every `.js` in the tree, sorted by path, so that at
 * least the ordering is reproducible. Whichever way the project's own were
 * chosen, **a library's sources go in front of them**: a project's class may
 * extend a library's, and never the other way round.
 */
GPtrArray *bta_project_sources(JSContext *ctx, const char *dir,
                               GPtrArray *libs, JSValueConst cfg)
{
    GPtrArray *out = g_ptr_array_new_with_free_func(g_free);
    JSValue    arr = JS_GetPropertyStr(ctx, cfg, "sources");

    if (JS_IsArray(arr)) {
        JSValue lenv = JS_GetPropertyStr(ctx, arr, "length");
        uint32_t n = 0;
        JS_ToUint32(ctx, &n, lenv);
        JS_FreeValue(ctx, lenv);

        for (uint32_t i = 0; i < n; i++) {
            JSValue     e = JS_GetPropertyUint32(ctx, arr, i);
            const char *s = JS_ToCString(ctx, e);
            if (s)
                g_ptr_array_add(out, g_build_filename(dir, s, NULL));
            JS_FreeCString(ctx, s);
            JS_FreeValue(ctx, e);
        }
    }
    JS_FreeValue(ctx, arr);

    if (out->len == 0) {
        bta_collect_js(out, dir, true);
        /* By path, so that a project without a "sources" list at least loads
         * the same way twice.  Which is all sorting can promise: a class that
         * extends another has to be loaded after it, and only an explicit list
         * can say so. */
        g_ptr_array_sort_values(out, (GCompareFunc)g_strcmp0);
    }

    GPtrArray *first = g_ptr_array_new_with_free_func(g_free);

    for (guint i = 0; libs && i < libs->len; i++) {
        const char *lib  = g_ptr_array_index(libs, i);
        GPtrArray  *mine = bta_library_sources(ctx, lib);

        for (guint j = 0; j < mine->len; j++)
            g_ptr_array_add(first, g_strdup(g_ptr_array_index(mine, j)));
        g_ptr_array_free(mine, TRUE);
    }
    for (guint i = 0; i < out->len; i++)
        g_ptr_array_add(first, g_strdup(g_ptr_array_index(out, i)));

    g_ptr_array_free(out, TRUE);
    return first;
}
