/*
 * The console host, `bintana`: `--version`, `check`, a project's `main` and
 * its tests, with no toolkit in the link. A project that declares `startup`
 * is exec'd as the graphical host (`bintana-gui`) with every word unchanged.
 * See `docs/notes/headless-runtime.md`, and `docs/plans/console-host-plan.md`
 * for what is left.
 *
 * **The language and the console globals are the graphical host's own
 * files.** The context comes from `bta_new_context` and is finished by
 * `bta_close_hatches` (bta_language.c), and `install_core` installs `File`,
 * `Exec`, `Http`, `Database`, `Task`, `Zip`, `Random`, `Message`, `Desktop`
 * and the rest out of the files `bintana-gui` links -- so a `main` is one
 * program under either binary. What stays out is what needs a display,
 * GStreamer or poppler (`GUI_GLOBALS`), and the drawing half, which is
 * `bintana-drawing.so`, loaded when a project's `uses` names `drawing`.
 *
 * **The widget classes are a document here**, not code: `check` loads the
 * `widgets.json` that `bintana-meta --dump` writes, and a `main` sees no
 * `Widget` at all.
 *
 * **What this file supplies.** `bta_runtime.c` owns the boot of the graphical
 * application; linking it would pull GTK. The few functions the shared files
 * name and a host answers -- the class lookup, the error dump, the file read,
 * the job drain, the application pointer, how a `Message` is shown, what a
 * `Task` worker gets beyond the shared globals -- are defined here.
 */
#include "bta.h"
#include "bta_prelude.h"

#include <errno.h>
#include <locale.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* ------------------------------------------------------- the core stubs */

/* The boot's application, for the one caller that asks: `bta_plugin.c` reaches
 * the context through it while a plugin's `init` runs. It is NULL everywhere
 * else, which is the answer the other core code expects. */
static BtaApp *headless_app;

BtaApp *bta_current_app(void)
{
    return headless_app;
}

/* A plugin that will not load must say why, and in the core stderr is where its
 * reader already is. `bta_plugin.c` calls this for every refusal. */
void bta_report_fatal(BtaApp *app, const char *message)
{
    (void)app;
    fprintf(stderr, "bintana: %s\n", message);
}

/* A console has no alert to raise; `Message` prints to stderr, as the
 * graphical host does when it has no display. */
bool bta_message_show(int kind, const char *text)
{
    (void)kind; (void)text;
    return false;
}

/* Whether any error was reported. A callback that throws after `main` returned
 * still has to reach the exit status, or a runner reads "it worked" over a
 * traceback -- the failure `run_console` fixes with `app->uncaught`. */
static bool headless_uncaught;

/* This host's half of an uncaught error (bta_error.c, which prints it and
 * calls `Application.OnError`): the run is marked, and there is nothing to
 * show -- the terminal had it. */
void bta_host_error_uncaught(void)
{
    headless_uncaught = true;
}

bool bta_host_show_error(JSContext *ctx, const char *msg, const char *stack)
{
    (void)ctx; (void)msg; (void)stack;
    return false;
}

void bta_prelude_sources(const char **rad, const char **forms)
{
    if (rad)
        *rad = bta_prelude_js;
    /* The widget half is not part of the console host; the metadata document
     * carries its members and their prose. */
    if (forms)
        *forms = "";
}

/* ----------------------------------------------------------- Application */

static JSValue headless_print(JSContext *ctx, JSValueConst this_val,
                              int argc, JSValueConst *argv)
{
    (void)this_val;
    for (int i = 0; i < argc; i++) {
        const char *text = JS_ToCString(ctx, argv[i]);
        if (!text)
            return JS_EXCEPTION;
        if (i)
            fputc(' ', stdout);
        fputs(text, stdout);
        JS_FreeCString(ctx, text);
    }
    fputc('\n', stdout);
    return JS_UNDEFINED;
}

/*
 * `Application.Quit(code)`, as the graphical host's `run_console` reads it:
 * the code is kept, the loop is stopped if it runs, and the run ends by its
 * own road -- workers joined, the context freed. It used to `exit()` on the
 * spot, which skipped all of that, and to read `Quit("fail")` as 0, which a
 * runner takes for success. A status is a number; `undefined` is the one
 * non-number that means 0.
 */
static bool       core_quitting;
static int32_t    core_exit_code;
static GMainLoop *core_loop;

static JSValue js_application_quit(JSContext *ctx, JSValueConst this_val,
                                   int argc, JSValueConst *argv)
{
    (void)this_val;
    int32_t code = 0;
    if (argc > 0 && !JS_IsUndefined(argv[0]) &&
        !bta_to_int(ctx, argv[0], "Application.Quit", &code))
        return JS_EXCEPTION;

    core_exit_code = code;
    core_quitting  = true;
    if (core_loop)
        g_main_loop_quit(core_loop);
    return JS_UNDEFINED;
}

/* The status a run ends with: `Quit`'s when the program said one, and
 * otherwise 1 if an error went uncaught -- a callback that threw after `main`
 * returned is not a success. */
static int core_status(void)
{
    if (core_quitting)
        return core_exit_code;
    return headless_uncaught ? 1 : 0;
}

static void install_application(JSContext *ctx, JSValueConst global,
                                const char *directory, const char *name,
                                const char *version, const char *id,
                                char **args, int nargs)
{
    JSValue application = JS_NewObject(ctx);

    JS_SetPropertyStr(ctx, application, "Id", JS_NewString(ctx, id ? id : ""));

    JS_SetPropertyStr(ctx, application, "Directory",
                      JS_NewString(ctx, directory ? directory : ""));
    JS_SetPropertyStr(ctx, application, "Name",
                      JS_NewString(ctx, name ? name : ""));
    JS_SetPropertyStr(ctx, application, "Version",
                      JS_NewString(ctx, version ? version : ""));

    char *config = g_build_filename(g_get_user_config_dir(), "bintana",
                                    name && *name ? name : "console", NULL);
    g_mkdir_with_parents(config, 0700);
    JS_SetPropertyStr(ctx, application, "ConfigDirectory", JS_NewString(ctx, config));
    g_free(config);

    char *exe = bta_exe_path();
    JS_SetPropertyStr(ctx, application, "Executable",
                      JS_NewString(ctx, exe ? exe : "bintana"));
    g_free(exe);

    JSValue arguments = JS_NewArray(ctx);
    for (int i = 0; i < nargs; i++)
        JS_SetPropertyUint32(ctx, arguments, i, JS_NewString(ctx, args[i]));
    JS_SetPropertyStr(ctx, application, "Arguments", arguments);
    JS_SetPropertyStr(ctx, application, "OnError", JS_NULL);
    /* ...which bta_dump_error (bta_error.c) calls when an error is not caught,
     * as in the graphical host. Its prose is the graphical host's row. */

    JS_SetPropertyStr(ctx, application, "Quit",
                      JS_NewCFunction(ctx, js_application_quit, "Quit", 1));
    JS_SetPropertyStr(ctx, application, "Symbols",
                      JS_NewCFunction(ctx, bta_application_symbols, "Symbols", 1));
    JS_SetPropertyStr(ctx, application, "CheckSource",
                      JS_NewCFunction(ctx, bta_application_check_source,
                                      "CheckSource", 1));
    JS_SetPropertyStr(ctx, application, "FreeNames",
                      JS_NewCFunction(ctx, bta_application_free_names,
                                      "FreeNames", 1));
    JS_SetPropertyStr(ctx, application, "Globals",
                      JS_NewCFunction(ctx, bta_application_globals, "Globals", 0));
    JS_SetPropertyStr(ctx, application, "LibraryPath",
                      JS_NewCFunction(ctx, bta_application_library_path,
                                      "LibraryPath", 2));
    JS_SetPropertyStr(ctx, application, "Libraries",
                      JS_NewCFunction(ctx, bta_application_libraries,
                                      "Libraries", 1));
    JS_SetPropertyStr(ctx, application, "Uses",
                      JS_NewCFunction(ctx, bta_application_uses, "Uses", 1));
    JS_SetPropertyStr(ctx, application, "HasCommand",
                      JS_NewCFunction(ctx, bta_application_has_command,
                                      "HasCommand", 1));
    JS_SetPropertyStr(ctx, application, "Replacements",
                      JS_NewCFunction(ctx, bta_application_replacements,
                                      "Replacements", 0));
    JS_SetPropertyStr(ctx, application, "ProtectPrototype",
                      JS_NewCFunction(ctx, bta_application_protect_prototype,
                                      "ProtectPrototype", 0));

    JS_SetPropertyStr(ctx, global, "Application", application);
}

static bool eval_script(JSContext *ctx, const char *text, size_t len,
                        const char *name)
{
    JSValue r = JS_Eval(ctx, text, len, name,
                        JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_STRICT);
    if (JS_IsException(r)) {
        bta_dump_error(ctx);
        JS_FreeValue(ctx, r);
        return false;
    }
    JS_FreeValue(ctx, r);
    return true;
}

/* A file of the project or of a library, through the loader both hosts share
 * (bta_module.c), which reports what goes wrong. */
static bool eval_file(JSContext *ctx, const char *path)
{
    return bta_eval_file(ctx, path) == 0;
}

/* `Widget` and the metadata rows, before rad.js: rad.js's `FormPart` and the
 * forms.js mixins chain onto the class prototypes. */
/*
 * The names the graphical host installs and this one does not.
 *
 * `lib/check` asks `Application.Globals()` what a program may write. A project
 * that names `Printer` must not be told the name does not exist because the
 * console host has no window: the names are the same surface, and the verb
 * behind one is what refuses. Empty objects are enough for the name pass;
 * Phase 3 replaces each with the sentence its call refuses with.
 *
 * **Only what needs a display, GStreamer or poppler is here.** `Http`,
 * `Database`, `Task`, `Zip`, `Random`, `Desktop` and the rest of what a
 * console program is written with are the real ones (`install_core`), the
 * same files the graphical host links.
 */
static const char *const GUI_GLOBALS[] = {
    "Dialog", "Screen", "Clipboard", "Printer", "Tray", "Notification",
    "Popover", "Probe", "Media", "AudioPlayer", "Video",
    /* The drawing and document globals. The check reads names, so a project
     * that draws a chart must not be told `Painter` does not exist because
     * this host has no cairo surface to hand it; the drawing module replaces
     * them when a project names `drawing`. */
    "Bitmap", "Drawing", "Painter", "PdfDocument",
};

static JSValue headless_strict_seal(JSContext *ctx, JSValueConst this_val,
                                    int argc, JSValueConst *argv)
{
    (void)ctx; (void)this_val; (void)argc; (void)argv;
    return JS_UNDEFINED;
}

void bta_strict_init(JSContext *ctx, JSValueConst global)
{
    JS_SetPropertyStr(ctx, global, "strictSeal",
                      JS_NewCFunction(ctx, headless_strict_seal, "strictSeal", 1));
}

static void install_gui_stubs(JSContext *ctx, JSValueConst global)
{
    for (size_t i = 0; i < G_N_ELEMENTS(GUI_GLOBALS); i++) {
        JSValue existing = JS_GetPropertyStr(ctx, global, GUI_GLOBALS[i]);
        bool    present  = !JS_IsUndefined(existing) && !JS_IsException(existing);

        if (JS_IsException(existing))
            JS_FreeValue(ctx, JS_GetException(ctx));
        JS_FreeValue(ctx, existing);
        if (present)
            continue;

        /* Names a check reads, not objects a program uses. A run replaces the
         * drawing ones with getters that load the module. */
        JS_SetPropertyStr(ctx, global, GUI_GLOBALS[i], JS_NewObject(ctx));
    }
}

/* `Printer.Papers` in a host with no printer: the table is data a document
 * lays itself out on (bta_util.c), and the rest of `Printer` is the
 * graphical host's. */
static JSValue core_printer_papers(JSContext *ctx, JSValueConst this_val)
{
    (void)this_val;
    return bta_papers_new(ctx);
}

static bool install_core(JSContext *ctx, JSValueConst global,
                         const char *project, GPtrArray *libs)
{
    bta_profile_init(ctx, global);
    bta_sys_init(ctx, global);
    bta_privilege_init(ctx, global, false);

    bta_logger_init(ctx, global);   /* bta_log.c, as in the graphical host */
    bta_message_init(ctx, global);
    bta_bytes_init(ctx, global);
    bta_decimal_init(ctx, global);
    bta_day_init(ctx, global);

    /* What a console program is written with, in the graphical host's order
     * and out of the same files: none of them names the toolkit. An optional
     * library that is missing (sqlite, libsoup, GnuTLS, libsecret, unixODBC)
     * leaves its global in place, refusing with the package's name -- the
     * same bargain the graphical host makes. */
    bta_database_init(ctx, global);
    bta_sqlite_init(ctx, global);
    bta_odbc_init(ctx, global);
    bta_http_init(ctx, global);
    bta_socket_init(ctx, global);
    bta_serial_init(ctx, global);
    bta_cancellable_init(ctx, global);
    bta_task_init(ctx, global);
    bta_lock_init(ctx, global);
    bta_random_init(ctx, global);
    bta_gzip_init(ctx, global);
    bta_cipher_init(ctx, global);
    bta_zip_init(ctx, global);
    bta_key_init(ctx, global);
    bta_xml_init(ctx, global);
    bta_keyring_init(ctx, global);
    bta_desktop_init(ctx, global);
    bta_network_init(ctx, global);

    /* The drawing module adds Width, Height, Bounds and the rest to this
     * object when a project runs; `LineOf` is the one editor answer `check`
     * needs and it never loads the module. */
    JSValue text = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, text, "LineOf",
                      JS_NewCFunction(ctx, bta_text_line_of, "LineOf", 2));
    JS_SetPropertyStr(ctx, global, "Text", text);
    bta_locale_init(ctx, global, project, libs);

    bta_record_init(ctx, global, project, libs);
    bta_class_of_name_init(ctx, global);
    bta_strict_init(ctx, global);
    install_gui_stubs(ctx, global);

    JSValue printer = JS_GetPropertyStr(ctx, global, "Printer");
    JSAtom  papers  = JS_NewAtom(ctx, "Papers");
    JS_DefinePropertyGetSet(ctx, printer, papers,
        JS_NewCFunction2(ctx, (JSCFunction *)(void *)core_printer_papers,
                         "Papers", 0, JS_CFUNC_getter, 0),
        JS_UNDEFINED, JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE);
    JS_FreeAtom(ctx, papers);
    JS_FreeValue(ctx, printer);
    return true;
}

static bool load_prelude(JSContext *ctx)
{
    /* The language only. `forms.js` is the widget half, and the console host
     * does not have widgets until `check` loads the metadata document. */
    return eval_script(ctx, bta_prelude_js, strlen(bta_prelude_js), "<rad.js>");
}

/* --------------------------------------------------------------- the CLI */

static char *find_check_project(void)
{
    GPtrArray *tried = g_ptr_array_new_with_free_func(g_free);
    char      *exe   = bta_exe_path();

    if (exe) {
        char *bin = g_path_get_dirname(exe);
        char *up  = g_path_get_dirname(bin);
        g_ptr_array_add(tried, g_build_filename(up, "tools", "check", NULL));
        g_ptr_array_add(tried, g_build_filename(up, "share", "bintana",
                                                "tools", "check", NULL));
        g_free(up);
        g_free(bin);
        g_free(exe);
    }
    g_ptr_array_add(tried, g_build_filename("/usr", "share", "bintana",
                                            "tools", "check", NULL));

    char *found = NULL;
    for (guint i = 0; i < tried->len && !found; i++) {
        char *main = g_build_filename(tried->pdata[i], "Main.js", NULL);
        if (g_file_test(main, G_FILE_TEST_IS_REGULAR))
            found = g_strdup(tried->pdata[i]);
        g_free(main);
    }
    g_ptr_array_unref(tried);
    return found;
}

typedef struct {
    char *meta;
    char *data;
} CheckData;

static CheckData find_check_data(void)
{
    CheckData out = { NULL, NULL };
    GPtrArray *dirs = g_ptr_array_new_with_free_func(g_free);
    char      *exe  = bta_exe_path();

    if (exe) {
        char *bin = g_path_get_dirname(exe);
        char *up  = g_path_get_dirname(bin);
        g_ptr_array_add(dirs, g_build_filename(bin, "check", NULL));
        g_ptr_array_add(dirs, g_build_filename(up, "share", "bintana",
                                               "check", NULL));
        g_free(up);
        g_free(bin);
        g_free(exe);
    }
    g_ptr_array_add(dirs, g_build_filename("/usr", "share", "bintana",
                                           "check", NULL));

    for (guint i = 0; i < dirs->len && !out.meta; i++) {
        char *meta = g_build_filename(dirs->pdata[i], "WidgetMeta.js", NULL);
        char *data = g_build_filename(dirs->pdata[i], "widgets.json", NULL);

        if (g_file_test(meta, G_FILE_TEST_IS_REGULAR) &&
            g_file_test(data, G_FILE_TEST_IS_REGULAR)) {
            out.meta = meta;
            out.data = data;
        } else {
            g_free(meta);
            g_free(data);
        }
    }
    g_ptr_array_unref(dirs);
    return out;
}

/* Defined below, beside the console loop; `check` lets go the same way. */
static void core_cleanup(void);

static int run_check(int argc, char **argv)
{
    if (argc < 1) {
        fprintf(stderr, "usage: bintana check [options] <project>\n");
        return 2;
    }

    char *tools = find_check_project();
    if (!tools) {
        fprintf(stderr, "bintana: tools/check is not beside the binary\n");
        return 2;
    }

    GString *tried   = g_string_new(NULL);
    char    *library = bta_library_resolve(tools, "check", tried);
    if (!library) {
        fprintf(stderr, "bintana: lib/check is not in any of:%s\n",
                tried->str);
        g_string_free(tried, TRUE);
        g_free(tools);
        return 2;
    }
    g_string_free(tried, TRUE);

    /* The options may come before the target, so they travel as they were
     * written: `tools/check` is the parser, and `File.Absolute` resolves the
     * target against the working directory the person ran the command in. */
    GPtrArray *libs = g_ptr_array_new_with_free_func(g_free);
    g_ptr_array_add(libs, g_strdup(library));

    JSRuntime *rt = JS_NewRuntime();
    if (!rt) {
        g_ptr_array_unref(libs);
        g_free(tools); g_free(library);
        return 2;
    }
    JS_SetMaxStackSize(rt, 2 * 1024 * 1024);

    JSContext *ctx = bta_new_context(rt);
    if (!ctx) {
        JS_FreeRuntime(rt);
        g_ptr_array_unref(libs);
        g_free(tools); g_free(library);
        return 2;
    }

    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "print",
                      JS_NewCFunction(ctx, headless_print, "print", 1));
    JS_SetPropertyStr(ctx, global, "BTA_VERSION",
                      JS_NewString(ctx, BTA_VERSION_STRING));
    install_application(ctx, global, tools, "check", "1.0", "", argv, argc);
    install_core(ctx, global, tools, libs);
    JS_FreeValue(ctx, global);

    if (!load_prelude(ctx)) {
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        g_ptr_array_unref(libs);
        g_free(tools); g_free(library);
        return 1;
    }

    /*
     * The widget metadata is a document, not a linked toolkit. It is loaded
     * here -- only for `check` -- and the class names it installs are what
     * `lib/check` and `Application.Globals` read.
     */
    CheckData data = find_check_data();
    if (!data.meta) {
        fprintf(stderr, "bintana: the check metadata is not installed "
                        "(WidgetMeta.js and widgets.json)\n");
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        g_ptr_array_unref(libs);
        g_free(tools); g_free(library);
        return 2;
    }

    JSValue meta_global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, meta_global, "WidgetDataPath",
                      JS_NewString(ctx, data.data));
    JS_FreeValue(ctx, meta_global);
    bool meta_ok = eval_file(ctx, data.meta);
    meta_global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, meta_global, "WidgetDataPath", JS_UNDEFINED);
    JS_FreeValue(ctx, meta_global);
    g_free(data.meta);
    g_free(data.data);
    if (!meta_ok) {
        JS_FreeContext(ctx);
        JS_FreeRuntime(rt);
        g_ptr_array_unref(libs);
        g_free(tools); g_free(library);
        return 1;
    }

    /* The metadata is this host's `forms.js`, and the hatches close after it
     * exactly as they do after the graphical host's prelude. */
    bta_close_hatches(ctx);

    /* After the prelude and the metadata, and before the program's modules:
     * the runtime names `Application.FreeNames` leaves out are photographed
     * here -- `Regex`, `Dictionary`, `Widget` and the class names. */
    bta_modules_scope(ctx, tools, libs);

    GPtrArray *files = bta_library_sources(ctx, library);
    bool       ok    = true;

    for (guint i = 0; i < files->len && ok; i++)
        ok = eval_file(ctx, files->pdata[i]);
    g_ptr_array_unref(files);

    char *main_js = g_build_filename(tools, "Main.js", NULL);
    if (ok)
        ok = eval_file(ctx, main_js);
    g_free(main_js);

    if (ok) {
        JSValue main = bta_lookup_global(ctx, "main");
        if (JS_IsException(main)) {
            JS_FreeValue(ctx, JS_GetException(ctx));
            fprintf(stderr, "bintana: tools/check declares no main\n");
            ok = false;
        } else if (!JS_IsFunction(ctx, main)) {
            fprintf(stderr, "bintana: 'main' is not a function\n");
            ok = false;
        } else {
            JSValue r = JS_Call(ctx, main, JS_UNDEFINED, 0, NULL);
            if (JS_IsException(r)) {
                bta_dump_error(ctx);
                ok = false;
            }
            JS_FreeValue(ctx, r);
            bta_drain_jobs(rt);
        }
        JS_FreeValue(ctx, main);
    }

    core_cleanup();
    bta_modules_forget(ctx);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    g_ptr_array_unref(libs);
    g_free(tools); g_free(library);
    return ok ? core_status() : 1;
}

/* --------------------------------------------------------- drawing module */

/*
 * The `.so` that carries cairo, Pango and GdkPixbuf, **loaded when a program
 * first touches what it brings**: `Painter`, `Drawing`, `Bitmap` and `Text`'s
 * measurements. A `main` that never draws never maps it; one that does gets it
 * the moment it asks, so a program is the same program under `bintana` and
 * `bintana-gui`, where the drawing half is always there. It used to load only
 * for a project whose `uses` named `drawing`, and every other `main` that drew
 * was told to add the line. `uses: ["drawing"]` still loads it at the start.
 *
 * It is found in two places and no others: beside the binary (the build tree),
 * and where this build installs it -- `BTA_BIN_TO_MODULES`, the hop from
 * bindir to the configured libdir, which CMake works out.
 *
 * **Opening is once per process, under a lock**, and installing is per
 * context: the main thread's gets the four, and a `Task` worker gets `Bitmap`
 * alone (`bta_drawing_module_worker_init`), which a worker may be the first to
 * ask for. A module that is missing, will not load, or speaks another ABI is
 * remembered with the sentence that says so, and every later ask answers it.
 */
typedef int  (*drawing_abi_fn)(void);
typedef bool (*drawing_init_fn)(JSContext *, JSValue);

static GMutex           drawing_lock;
static bool             drawing_tried;
static char            *drawing_error;
static drawing_init_fn  drawing_init;
static drawing_init_fn  drawing_worker_init;

static bool drawing_open(void)
{
    g_mutex_lock(&drawing_lock);
    if (drawing_tried) {
        bool ok = drawing_init != NULL;
        g_mutex_unlock(&drawing_lock);
        return ok;
    }
    drawing_tried = true;

    GPtrArray *tried = g_ptr_array_new_with_free_func(g_free);
    char      *exe   = bta_exe_path();

    if (exe) {
        char *bin = g_path_get_dirname(exe);

        g_ptr_array_add(tried, g_build_filename(bin, "bintana-drawing." G_MODULE_SUFFIX, NULL));
#ifdef BTA_BIN_TO_MODULES
        char *dir = g_build_filename(bin, BTA_BIN_TO_MODULES, NULL);

        g_ptr_array_add(tried, g_canonicalize_filename(
            "bintana-drawing." G_MODULE_SUFFIX, dir));
        g_free(dir);
#endif
        g_free(bin);
        g_free(exe);
    }

    char *path = NULL;
    for (guint i = 0; i < tried->len && !path; i++)
        if (g_file_test(tried->pdata[i], G_FILE_TEST_IS_REGULAR))
            path = g_strdup(tried->pdata[i]);

    if (!path) {
        GString *s = g_string_new(NULL);

        g_string_printf(s, "drawing needs bintana-drawing.%s, which is not in "
                           "any of:", G_MODULE_SUFFIX);
        for (guint i = 0; i < tried->len; i++)
            g_string_append_printf(s, "\n  %s", (char *)tried->pdata[i]);
        drawing_error = g_string_free(s, FALSE);
        g_ptr_array_unref(tried);
        g_mutex_unlock(&drawing_lock);
        return false;
    }
    g_ptr_array_unref(tried);

    GModule *m = g_module_open(path, G_MODULE_BIND_LOCAL);
    gpointer abi_sym = NULL, init_sym = NULL, worker_sym = NULL;

    if (!m) {
        drawing_error = g_strdup_printf("the drawing module %s did not load: %s",
                                        path, g_module_error() ?: "unknown");
    } else if (!g_module_symbol(m, "bta_drawing_module_abi", &abi_sym) ||
               !g_module_symbol(m, "bta_drawing_module_init", &init_sym) ||
               !abi_sym || !init_sym) {
        drawing_error = g_strdup_printf("%s is not a drawing module", path);
    } else if (((drawing_abi_fn)abi_sym)() != BTA_DRAWING_MODULE_ABI) {
        drawing_error = g_strdup_printf("%s speaks drawing ABI %d, this runtime "
                                        "%d -- rebuild it with this runtime",
                                        path, ((drawing_abi_fn)abi_sym)(),
                                        BTA_DRAWING_MODULE_ABI);
    } else {
        /* Never closed: the classes it registers live as long as the process. */
        drawing_init = (drawing_init_fn)init_sym;
        if (g_module_symbol(m, "bta_drawing_module_worker_init", &worker_sym))
            drawing_worker_init = (drawing_init_fn)worker_sym;
    }
    if (!drawing_init && m)
        g_module_close(m);
    g_free(path);

    bool ok = drawing_init != NULL;
    g_mutex_unlock(&drawing_lock);
    return ok;
}

/* The names the module brings, which stand in as getters until it loads. The
 * list is held to the module by tests/headless.sh, which compares `Text`'s
 * members and the globals with the graphical host's. */
static const char *const DRAWING_GLOBALS[] = { "Painter", "Drawing", "Bitmap" };
static const char *const TEXT_MEASURES[]   = {
    "Width", "Height", "Size", "Lines", "Escape", "IndexAt", "Bounds",
    "OffsetAt", "Font",
};

static void drawing_forget_getters(JSContext *ctx, JSValueConst global)
{
    for (size_t i = 0; i < G_N_ELEMENTS(DRAWING_GLOBALS); i++) {
        JSAtom a = JS_NewAtom(ctx, DRAWING_GLOBALS[i]);
        JS_DeleteProperty(ctx, global, a, 0);
        JS_FreeAtom(ctx, a);
    }
    JSValue text = JS_GetPropertyStr(ctx, global, "Text");
    if (JS_IsObject(text))
        for (size_t i = 0; i < G_N_ELEMENTS(TEXT_MEASURES); i++) {
            JSAtom a = JS_NewAtom(ctx, TEXT_MEASURES[i]);
            JS_DeleteProperty(ctx, text, a, 0);
            JS_FreeAtom(ctx, a);
        }
    JS_FreeValue(ctx, text);
}

/* Load and install into this, the main, context. With `uses: ["drawing"]`
 * at the start; otherwise from a getter, the first time a name is touched. */
static bool drawing_in_main;   /* installed into the main context */

static bool drawing_load(JSContext *ctx, JSValueConst global)
{
    if (drawing_in_main)
        return true;
    if (!drawing_open())
        return false;
    drawing_forget_getters(ctx, global);
    if (!drawing_init(ctx, (JSValue)global)) {
        g_mutex_lock(&drawing_lock);
        if (!drawing_error)
            drawing_error = g_strdup("the drawing module refused to install itself");
        g_mutex_unlock(&drawing_lock);
        return false;
    }
    drawing_in_main = true;
    return true;
}

/* magic: 0..2 a global, 16.. a `Text` member, 32 the worker's `Bitmap`. */
enum { DRAWING_TEXT = 16, DRAWING_WORKER_BITMAP = 32 };

static const char *drawing_name(int magic)
{
    if (magic == DRAWING_WORKER_BITMAP)
        return "Bitmap";
    return magic >= DRAWING_TEXT ? TEXT_MEASURES[magic - DRAWING_TEXT]
                                 : DRAWING_GLOBALS[magic];
}

/* Load, then hand back what the name means now. A setter is the same and
 * then assigns, so `Text.Font = ...` before any measurement works too. */
static JSValue drawing_touch(JSContext *ctx, JSValueConst this_val, int magic,
                             JSValueConst *value)
{
    JSValue global = JS_GetGlobalObject(ctx);
    bool    ok;

    /* A worker never loads the module itself: `bta_task_starting` loaded it
     * on the main thread before the worker existed, so reaching here from a
     * worker means it is not to be had, and the sentence says why. */
    ok = magic != DRAWING_WORKER_BITMAP && drawing_load(ctx, global);

    if (!ok) {
        JS_FreeValue(ctx, global);
        g_mutex_lock(&drawing_lock);
        JSValue e = bta_throw_text(ctx, "%s", drawing_error
                                   ? drawing_error
                                   : "the drawing module is not loaded");
        g_mutex_unlock(&drawing_lock);
        return e;
    }

    const char *name   = drawing_name(magic);
    JSValue     holder = magic >= DRAWING_TEXT && magic != DRAWING_WORKER_BITMAP
                       ? JS_DupValue(ctx, this_val) : JS_DupValue(ctx, global);
    JSValue     out;

    if (value) {
        out = JS_SetPropertyStr(ctx, holder, name, JS_DupValue(ctx, *value)) < 0
            ? JS_EXCEPTION : JS_UNDEFINED;
    } else {
        out = JS_GetPropertyStr(ctx, holder, name);
    }
    JS_FreeValue(ctx, holder);
    JS_FreeValue(ctx, global);
    return out;
}

static JSValue drawing_get(JSContext *ctx, JSValueConst this_val, int magic)
{
    return drawing_touch(ctx, this_val, magic, NULL);
}

static JSValue drawing_set(JSContext *ctx, JSValueConst this_val, JSValueConst v,
                           int magic)
{
    return drawing_touch(ctx, this_val, magic, &v);
}

static void drawing_getter(JSContext *ctx, JSValueConst obj, const char *name,
                           int magic)
{
    JSAtom a = JS_NewAtom(ctx, name);

    JS_DefinePropertyGetSet(ctx, obj, a,
        JS_NewCFunction2(ctx, (JSCFunction *)(void *)drawing_get, name, 0,
                         JS_CFUNC_getter_magic, magic),
        JS_NewCFunction2(ctx, (JSCFunction *)(void *)drawing_set, name, 1,
                         JS_CFUNC_setter_magic, magic),
        JS_PROP_CONFIGURABLE | JS_PROP_ENUMERABLE);
    JS_FreeAtom(ctx, a);
}

/* The main context's stand-ins: the three globals in place of the check's
 * empty objects, and `Text`'s measurements beside its `LineOf`. */
static void drawing_install_getters(JSContext *ctx, JSValueConst global)
{
    for (size_t i = 0; i < G_N_ELEMENTS(DRAWING_GLOBALS); i++) {
        JSAtom a = JS_NewAtom(ctx, DRAWING_GLOBALS[i]);
        JS_DeleteProperty(ctx, global, a, 0);
        JS_FreeAtom(ctx, a);
        drawing_getter(ctx, global, DRAWING_GLOBALS[i], (int)i);
    }
    JSValue text = JS_GetPropertyStr(ctx, global, "Text");
    if (JS_IsObject(text))
        for (size_t i = 0; i < G_N_ELEMENTS(TEXT_MEASURES); i++)
            drawing_getter(ctx, text, TEXT_MEASURES[i], DRAWING_TEXT + (int)i);
    JS_FreeValue(ctx, text);
}

/*
 * Before a `Task` starts, on the main thread: load the module here if it is to
 * be had, so `Bitmap`'s class is numbered by the main runtime before a worker
 * registers it. QuickJS-ng numbers a class by the runtime that asks first and
 * keeps the number in one process-wide variable; a worker that asked first
 * took a low number the main runtime had already given another class, and
 * the main thread's later registration overwrote it -- a GC assertion, found
 * by `tests/headless/projects/lazydraw`. A program that starts a task maps
 * cairo whether or not it draws, which is what the graphical host always does.
 */
void bta_task_starting(JSContext *ctx)
{
    if (drawing_in_main)
        return;

    JSValue global = JS_GetGlobalObject(ctx);
    drawing_load(ctx, global);       /* not to be had: a worker says so */
    JS_FreeValue(ctx, global);
}

/* A `Task` worker's share of the module: `Bitmap`, as a worker in the
 * graphical host gets it -- or, when the module is not to be had, a getter
 * that says why. Read from the worker's thread after `bta_task_starting`
 * settled it on the main one. */
void bta_task_worker_host(JSContext *ctx, JSValueConst global)
{
    g_mutex_lock(&drawing_lock);
    drawing_init_fn worker = drawing_init ? drawing_worker_init : NULL;
    g_mutex_unlock(&drawing_lock);

    if (worker && drawing_in_main)
        worker(ctx, (JSValue)global);
    else
        drawing_getter(ctx, global, "Bitmap", DRAWING_WORKER_BITMAP);
}

/* What is still owed an answer: the same sum `run_console` adds up in the
 * graphical host, minus `Media`, which this host does not link. A `main` that
 * starts an `Http` request, a `Task` or a `Network.Reach` must not exit before
 * the answer arrives and its callback runs. */
static int core_pending(void)
{
    return bta_sys_pending() + bta_http_pending() + bta_socket_pending() +
           bta_serial_pending() + bta_task_pending() + bta_keyring_pending() +
           bta_network_pending();
}

/* The services this host links, let go before the context, in the graphical
 * host's order: workers first, since they hold values of this context and run
 * on their own threads. */
static void core_cleanup(void)
{
    bta_task_cleanup();
    bta_sys_cleanup();
    bta_http_cleanup();
    bta_keyring_cleanup();
    bta_network_cleanup();
    bta_socket_cleanup();
    bta_serial_cleanup();
}

/* The console loop's own tick: stop once the services that answer later have
 * nothing left. **It never removes itself**: the caller removes the source
 * after the loop returns, and a source that had already gone was a
 * `GLib-CRITICAL` on every run that waited -- the same reason `console_idle`
 * in the graphical host answers CONTINUE. */
static gboolean project_idle(gpointer data)
{
    GMainLoop *loop = data;

    if (core_pending() > 0)
        return G_SOURCE_CONTINUE;

    g_main_loop_quit(loop);
    return G_SOURCE_CONTINUE;
}

/* Run the loop while anything is owed an answer, unless the program already
 * said `Quit`; `Quit` from a callback stops it through `core_loop`. */
static void core_wait(void)
{
    if (core_quitting || core_pending() == 0)
        return;

    core_loop = g_main_loop_new(NULL, FALSE);
    guint tick = g_timeout_add(20, project_idle, core_loop);

    g_main_loop_run(core_loop);
    g_source_remove(tick);
    g_main_loop_unref(core_loop);
    core_loop = NULL;
}

/*
 * `bintana test`'s own half, for a project whose tests need no window: the
 * files the graphical host's `run_tests` reads, and `runTests` from rad.js.
 * The test classes are the project's, loaded after its sources, exactly as in
 * the graphical host.
 */
static bool run_tests_here(JSContext *ctx, const char *dir,
                           const char *filter, bool json)
{
    char      *where = g_build_filename(dir, "tests", NULL);
    GPtrArray *files = g_ptr_array_new_with_free_func(g_free);
    GDir      *d     = g_dir_open(where, 0, NULL);

    if (d) {
        const char *entry;
        while ((entry = g_dir_read_name(d)))
            if (g_str_has_suffix(entry, "Test.js"))
                g_ptr_array_add(files, g_build_filename(where, entry, NULL));
        g_dir_close(d);
    }
    g_ptr_array_sort_values(files, (GCompareFunc)g_strcmp0);
    g_free(where);

    JSValue found = JS_NewArray(ctx);

    for (guint i = 0; i < files->len; i++) {
        const char *path = files->pdata[i];
        char       *base = g_path_get_basename(path);

        base[strlen(base) - 3] = '\0';              /* QuoteTest.js -> QuoteTest */

        JSValue t = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, t, "Name", JS_NewString(ctx, base));
        JS_SetPropertyStr(ctx, t, "File", JS_NewString(ctx, path));

        if (!eval_file(ctx, path)) {
            JS_SetPropertyStr(ctx, t, "Error",
                              JS_NewString(ctx, "the file did not load; the error is above"));
        } else {
            JSValue klass = bta_lookup_global(ctx, base);

            if (JS_IsException(klass)) {
                JS_FreeValue(ctx, JS_GetException(ctx));
                klass = JS_UNDEFINED;
            }
            if (JS_IsFunction(ctx, klass)) {
                JS_SetPropertyStr(ctx, t, "Class", klass);
            } else {
                JS_FreeValue(ctx, klass);
                char *why = g_strdup_printf("the file declares no class %s", base);
                JS_SetPropertyStr(ctx, t, "Error", JS_NewString(ctx, why));
                g_free(why);
            }
        }
        JS_SetPropertyUint32(ctx, found, i, t);
        g_free(base);
    }
    g_ptr_array_free(files, TRUE);

    JSValue global = JS_GetGlobalObject(ctx);
    JSValue fn     = JS_GetPropertyStr(ctx, global, "runTests");

    bool ok = JS_IsFunction(ctx, fn);
    if (ok) {
        JSValue argv[3] = {
            found,
            JS_NewString(ctx, filter ? filter : ""),
            JS_NewBool(ctx, json),
        };
        JSValue r = JS_Call(ctx, fn, JS_UNDEFINED, 3, (JSValueConst *)argv);

        if (JS_IsException(r)) {
            bta_dump_error(ctx);
            ok = false;
        }
        JS_FreeValue(ctx, r);
        JS_FreeValue(ctx, argv[1]);
    } else {
        fprintf(stderr, "bintana: runTests is not in the language\n");
    }
    JS_FreeValue(ctx, found);
    JS_FreeValue(ctx, fn);
    JS_FreeValue(ctx, global);
    bta_drain_jobs(JS_GetRuntime(ctx));
    return ok;
}

/*
 * `bintana [run] <project> [args...]`: the project's own `main`, or its tests.
 *
 * A project that declares `startup` is dispatched before this is reached; the
 * refusal below is the fallback for a manifest that could not be read as one
 * or the other, and it names the form instead of failing later with a
 * `ReferenceError` about a widget.
 *
 * The classes are the core's. `Widget` is not installed for a `main` -- a
 * console project that asks for a control does not get a stub that pretends;
 * it gets the language's own "not defined", which is the truth about this
 * binary.
 */
static int run_project(int argc, char **argv, bool testing, bool json,
                       const char *filter)
{
    if (argc < 1) {
        fprintf(stderr, "usage: bintana [run] <project> [args...]\n");
        return 2;
    }

    char   *dir      = bta_project_dir(argv[0]);
    char   *manifest = bta_project_manifest(dir);
    size_t  len      = 0;
    char   *text     = bta_read_file(manifest, &len);

    if (!text) {
        fprintf(stderr, "bintana: no project.btp in %s\n", dir);
        g_free(manifest);
        g_free(dir);
        return 2;
    }

    JSRuntime *rt = JS_NewRuntime();
    if (!rt) {
        g_free(text); g_free(manifest); g_free(dir);
        return 2;
    }
    JS_SetMaxStackSize(rt, 2 * 1024 * 1024);

    JSContext *ctx = bta_new_context(rt);
    if (!ctx) {
        JS_FreeRuntime(rt);
        g_free(text); g_free(manifest); g_free(dir);
        return 2;
    }

    int      status = 1;
    BtaApp   app    = { 0 };
    JSValue  global = JS_GetGlobalObject(ctx);
    JSValue  cfg    = JS_UNDEFINED;
    JSValue  entry  = JS_UNDEFINED;
    GPtrArray *libs = NULL, *sources = NULL;
    char    *name = NULL, *version = NULL, *startup = NULL, *entry_name = NULL;
    char    *id = NULL;

    JS_SetPropertyStr(ctx, global, "print",
                      JS_NewCFunction(ctx, headless_print, "print", 1));
    JS_SetPropertyStr(ctx, global, "BTA_VERSION",
                      JS_NewString(ctx, BTA_VERSION_STRING));

    cfg = JS_ParseJSON(ctx, text, len, manifest);
    if (JS_IsException(cfg)) {
        bta_dump_error(ctx);
        goto out;
    }

    char *base    = g_path_get_basename(dir);
    name          = bta_project_string(ctx, cfg, "name", base);
    version       = bta_project_string(ctx, cfg, "version", "");
    startup       = bta_project_string(ctx, cfg, "startup", "Form1");
    entry_name    = bta_project_string(ctx, cfg, "main", NULL);
    g_free(base);
    id            = bta_project_string(ctx, cfg, "id", "");

    /* The graphical host's rule, and its sentence: an id that is not an
     * application id stops the program when the project loads, in either
     * host, rather than becoming a wrong name somewhere nobody looks. */
    if (id[0] && !g_application_id_is_valid(id)) {
        fprintf(stderr,
                "bintana: project.btp id \"%s\" is not an application id "
                "(a reverse-DNS name like org.example.App)\n", id);
        status = 2;
        goto out;
    }

    if (!entry_name && !testing) {
        fprintf(stderr,
                "bintana: '%s' opens a window (startup '%s'); this "
                "host has no display. Run it with bintana-gui.\n",
                name, startup);
        status = 2;
        goto out;
    }

    /* The words after the project are the program's, as `Application.Arguments`
     * describes them in the graphical runtime. */
    install_application(ctx, global, dir, name, version, id, argv + 1, argc - 1);
    libs    = bta_project_libs(ctx, dir, cfg);
    sources = bta_project_sources(ctx, dir, NULL, cfg);
    /* The helpers `Privilege.Run` may start: a `main` may ask too. */
    app.privileged = bta_project_privileged(ctx, dir, cfg);
    if (!app.privileged) {
        status = 2;
        goto out;
    }

    /* A library that declares `"display": true` is a window project's, and
     * this host has no display: refused by name before a line of it runs,
     * directly named or reached through another library's `uses`. */
    for (guint i = 0; i < libs->len; i++) {
        if (!bta_library_needs_display(ctx, libs->pdata[i]))
            continue;
        char *lib = g_path_get_basename(libs->pdata[i]);

        fprintf(stderr, "bintana: library \"%s\" needs the graphical host: "
                        "a project with \"main\" has no display. Run it with "
                        "bintana-gui.\n", lib);
        g_free(lib);
        status = 2;
        goto out;
    }
    install_core(ctx, global, dir, libs);

    /* The drawing module: at the start when the resolved `uses` names
     * `drawing` -- directly or through a library's own -- and otherwise on
     * the first touch of what it brings. A `main` that never draws never maps
     * cairo, Pango or GdkPixbuf. */
    bool needs_drawing = false;
    for (guint i = 0; i < libs->len && !needs_drawing; i++) {
        char *base = g_path_get_basename(libs->pdata[i]);

        needs_drawing = !strcmp(base, "drawing");
        g_free(base);
    }
    if (needs_drawing && !drawing_load(ctx, global)) {
        fprintf(stderr, "bintana: this project uses \"drawing\": %s\n",
                drawing_error);
        status = 2;
        goto out;
    }
    if (!needs_drawing)
        drawing_install_getters(ctx, global);

    /* A library's native half loads before `rad.js` and before the project's
     * own sources, which is the contract `bta_plugin.h` states: `init` sees
     * `Application` but not `Dictionary`. */
    app.ctx     = ctx;
    app.dir     = dir;
    app.name    = name;
    app.version = version;
    app.libs    = libs;
    /* NULL-terminated, as `BtaApp.args` is: a `Task` hands the worker the
     * same `Application.Arguments` the main thread has. The strings are
     * argv's; only the array is ours. */
    app.args    = g_new0(char *, argc > 0 ? argc : 1);
    for (int i = 1; i < argc; i++)
        app.args[i - 1] = argv[i];
    headless_app = &app;
    if (!bta_plugins_load(&app, ctx, global)) {
        status = 2;
        goto out;
    }

    if (!load_prelude(ctx))
        goto out;

    /* Last, and only after rad.js: it captured what it needs. The same
     * closing the graphical host makes, so a `main` is one language in both. */
    bta_close_hatches(ctx);

    /* `--debug` was set before the project was read; it installs the protocol
     * only when somebody asked. Descriptor 3 and stdin arrive from the IDE
     * untouched, the same way the graphical host's console branch gets them. */
    bta_debug_start(ctx);

    bta_modules_scope(ctx, dir, libs);

    /* A library's sources first, then the project's own -- less the files a
     * library lists under `"display"`: its controls, which extend `Component`
     * and are a window project's (`Chart.js` beside `ChartDocument.js`). */
    for (guint i = 0; i < libs->len; i++) {
        GPtrArray *files = bta_library_sources(ctx, libs->pdata[i]);
        GPtrArray *skip  = bta_library_display_files(ctx, libs->pdata[i]);

        for (guint j = 0; j < files->len; j++) {
            char *base = g_path_get_basename(files->pdata[j]);
            bool  ui   = false;

            for (guint k = 0; k < skip->len && !ui; k++)
                ui = !strcmp(base, skip->pdata[k]);
            g_free(base);
            if (!ui && !eval_file(ctx, files->pdata[j])) {
                g_ptr_array_unref(skip);
                g_ptr_array_unref(files);
                goto out;
            }
        }
        g_ptr_array_unref(skip);
        g_ptr_array_unref(files);
    }

    for (guint i = 0; i < sources->len; i++)
        if (!eval_file(ctx, sources->pdata[i]))
            goto out;

    if (bta_modules_check(ctx) < 0) {
        bta_dump_error(ctx);
        goto out;
    }

    if (testing) {
        if (!run_tests_here(ctx, dir, filter, json)) {
            status = 2;
            goto out;
        }
        /* `runTests` schedules the next test with `Timer.After(0, ...)` and
         * ends with `Application.Quit`, so the loop is what lets a test run at
         * all, and `Quit` is what ends it with the tests' status. */
        core_wait();
        status = core_status();
        goto out;
    }

    entry = bta_lookup_global(ctx, entry_name);
    if (JS_IsException(entry)) {
        bta_dump_error(ctx);
        goto out;
    }
    if (!JS_IsFunction(ctx, entry)) {
        fprintf(stderr, "bintana: main function '%s' not found\n",
                entry_name);
        goto out;
    }

    JSValue r = JS_Call(ctx, entry, JS_UNDEFINED, 0, NULL);
    if (JS_IsException(r)) {
        bta_dump_error(ctx);
        JS_FreeValue(ctx, r);
        goto out;
    }
    JS_FreeValue(ctx, r);
    bta_drain_jobs(rt);

    core_wait();
    status = core_status();

out:
    /* Before anything they could touch goes: a worker holds values of this
     * context, and an `Http` answer still queued holds its callback. */
    core_cleanup();
    if (libs)    g_ptr_array_unref(libs);
    if (sources) g_ptr_array_unref(sources);
    g_free(name);
    g_free(version);
    g_free(startup);
    g_free(entry_name);
    g_free(id);
    JS_FreeValue(ctx, entry);
    JS_FreeValue(ctx, cfg);
    JS_FreeValue(ctx, global);
    bta_modules_forget(ctx);
    JS_FreeContext(ctx);
    JS_FreeRuntime(rt);
    /* The contract says a plugin's cleanup runs after the context is gone and
     * must not call the host; the loader's list is C only. */
    bta_plugins_cleanup(&app);
    if (app.privileged)
        g_ptr_array_unref(app.privileged);
    headless_app = NULL;
    g_free(app.args);
    g_free(text);
    g_free(manifest);
    g_free(dir);
    return status;
}

/* ------------------------------------------------------------- dispatch */

/* The options that take the next word with them. The first bare word is the
 * project; everything after it belongs to the program, as in `bintana`. */
static bool option_takes_value(const char *word)
{
    return !strcmp(word, "--form")      || !strcmp(word, "--theme") ||
           !strcmp(word, "--text-scale") || !strcmp(word, "--profile");
}

/*
 * The graphical host: `$BINTANA_GUI` when set, otherwise `bintana-gui` beside
 * this binary -- the installed split, and the source tree's build too.
 *
 * The answer is never this process itself: a name that resolves to the console
 * host would exec it again, forever, and that includes a `BINTANA_GUI` that
 * names it by mistake.
 */
/* A path with its symbolic links followed, as `/proc/self/exe` answers this
 * process's own; the path as given when it cannot be resolved (a host that is
 * not there is `exec`'s sentence to say). `g_canonicalize_filename` tidies a
 * path and follows no link, so a `bintana-gui` that is a link to `bintana`
 * compared unequal and was exec'd -- this process again, forever. */
static char *resolved(const char *path)
{
    char *real = realpath(path, NULL);
    char *out  = g_strdup(real ? real : path);

    free(real);
    return out;
}

static char *find_gui_host(void)
{
    char *self = bta_exe_path();
    const char *env = g_getenv("BINTANA_GUI");

    if (env && *env) {
        char *gui  = g_canonicalize_filename(env, NULL);
        char *real = resolved(gui);
        bool  same = self && !g_strcmp0(real, self);

        g_free(real);
        if (same) {
            fprintf(stderr, "bintana: BINTANA_GUI names this console "
                            "host; it needs the graphical one\n");
            g_free(gui);
            g_free(self);
            return NULL;
        }
        g_free(self);
        return gui;
    }

    if (self) {
        char *bin = g_path_get_dirname(self);
        char *gui  = g_build_filename(bin, "bintana-gui", NULL);
        char *real = resolved(gui);
        bool  same = !g_strcmp0(real, self);

        g_free(real);
        if (g_file_test(gui, G_FILE_TEST_IS_EXECUTABLE) && !same) {
            g_free(bin);
            g_free(self);
            return gui;
        }
        g_free(gui);
        g_free(bin);
    }
    g_free(self);
    return NULL;
}

/* Replace this process with the graphical host, every word and descriptor as
 * it arrived. `lead` is the command word the graphical host expects (`test`)
 * or NULL for a run; the exit status is that host's, which is what a runner
 * reads. */
static int exec_gui_lead(const char *gui, const char *lead,
                         char **words, int nwords)
{
    int   extra = lead ? 1 : 0;
    char **args = g_new0(char *, (gsize)nwords + (gsize)extra + 2);

    args[0] = (char *)gui;
    if (lead)
        args[1] = (char *)lead;
    for (int i = 0; i < nwords; i++)
        args[1 + extra + i] = words[i];

    /*
     * **A dispatched process carries a mark**, and the graphical host clears
     * it as it starts (main.c). Arriving here with the mark still set means
     * the "graphical host" ran this console host again -- a script around
     * `bintana`, which no path comparison can see through -- and the next
     * `exec` would be the same loop, forever. It stops with a sentence.
     */
    if (g_getenv("BINTANA_DISPATCHED")) {
        fprintf(stderr, "bintana: the graphical host %s started the console "
                        "host again; BINTANA_GUI, or bintana-gui beside this "
                        "binary, must be the graphical host\n", gui);
        g_free(args);
        return 2;
    }
    g_setenv("BINTANA_DISPATCHED", "1", TRUE);

    execv(gui, args);
    g_unsetenv("BINTANA_DISPATCHED");
    fprintf(stderr, "bintana: cannot run the graphical host %s: %s\n",
            gui, g_strerror(errno));
    g_free(args);
    return 2;
}

static int exec_gui(const char *gui, char **words, int nwords)
{
    return exec_gui_lead(gui, NULL, words, nwords);
}

/*
 * `bintana test [--json] <project> [filter]`: the graphical host owns a
 * `startup` project's tests, because they build widgets; a `main` project's run
 * here, with no toolkit. The words travel whole, so `test` and `--json` mean
 * the same thing in both hosts.
 */
static int run_test_command(int argc, char **argv)
{
    const char *project = NULL;
    const char *filter  = NULL;
    bool        json    = false;

    for (int i = 0; i < argc; i++) {
        if (!strcmp(argv[i], "--json")) {
            json = true;
            continue;
        }
        if (argv[i][0] == '-' && !project) {
            fprintf(stderr, "bintana: unknown option '%s'\n", argv[i]);
            return 2;
        }
        if (!project)
            project = argv[i];
        else if (!filter)
            filter = argv[i];
    }
    if (!project) {
        fprintf(stderr, "usage: bintana test [--json] <project> [filter]\n");
        return 2;
    }

    char *dir      = bta_project_dir(project);
    int   has_main = bta_project_has_main(dir);

    if (has_main == 0) {
        char *gui = find_gui_host();

        if (!gui) {
            char *name = g_path_get_basename(dir);

            fprintf(stderr, "bintana: '%s' runs its tests in a window, and "
                            "no graphical host is beside this binary. Install "
                            "bintana-gui there, or set BINTANA_GUI to it.\n",
                    name);
            g_free(name);
            g_free(dir);
            return 2;
        }
        g_free(dir);
        return exec_gui_lead(gui, "test", argv, argc);
    }
    g_free(dir);

    char *one[1] = { (char *)project };

    return run_project(1, one, true, json, filter);
}

static void usage(void)
{
    fputs("usage: bintana [run] <project> [args...]\n"
          "       bintana test [--json] <project> [filter]\n"
          "       bintana check [options] <project>\n"
          "       bintana --version\n", stderr);
}

/* What an option before the project means to a `main`. `--debug`, `--strict`
 * and `--profile` are the run's; the look and the form options are the
 * graphical host's and are forwarded there, as the plan says. */
static bool is_look_option(const char *word)
{
    return !strcmp(word, "--form") || !strcmp(word, "--theme") ||
           !strcmp(word, "--text-scale") || !strcmp(word, "--rtl");
}



int main(int argc, char **argv)
{
    /*
     * The desktop's locale, as the graphical host asks for it first thing
     * (main.c). The console host never did, so every `main` ran in the C
     * locale: `Locale.Number(1234.5, 2)` was `1234.50` on a Spanish desktop
     * where `bintana-gui` said `1.234,50`, and `Locale.Compare` sorted by
     * byte -- which is also why `bintana check` listed a project's files in
     * another order than the graphical check. Machine text does not
     * depend on it: CSS, JSON and numbers for C go through `g_ascii_*`.
     */
    setlocale(LC_ALL, "");

    if (argc >= 2 && (!strcmp(argv[1], "--version") || !strcmp(argv[1], "-v"))) {
        printf("bintana %s\n", BTA_VERSION_STRING);
        return 0;
    }
    if (argc >= 2 && (!strcmp(argv[1], "-h") || !strcmp(argv[1], "--help"))) {
        fputs("usage: bintana [run] <project> [args...]\n"
              "       bintana test [--json] <project> [filter]\n"
              "       bintana check [options] <project>\n"
              "       bintana --version\n", stdout);
        return 0;
    }
    if (argc >= 2 && !strcmp(argv[1], "check"))
        return run_check(argc - 2, argv + 2);
    if (argc >= 2 && !strcmp(argv[1], "test"))
        return run_test_command(argc - 2, argv + 2);

    /* `run` is a word, not an option, and it says nothing the first bare word
     * does not: it is dropped before the project is looked for. */
    int first = 1;
    if (argc > first && !strcmp(argv[first], "run"))
        first++;
    if (first >= argc) {
        usage();
        return 2;
    }

    char **words  = argv + first;
    int    nwords = argc - first;
    int    project = -1;

    for (int i = 0; i < nwords; i++) {
        if (words[i][0] != '-') {
            project = i;
            break;
        }
        if (option_takes_value(words[i])) {
            if (i + 1 >= nwords) {
                fprintf(stderr, "bintana: %s needs a value\n", words[i]);
                return 2;
            }
            i++;
        }
    }
    if (project < 0) {
        usage();
        return 2;
    }

    /* The kind of project decides which host runs it, and it is answered from
     * the manifest without a QuickJS context: a window project must exec the
     * graphical host, not build the language to find out it has nothing to do
     * here. */
    char *dir = bta_project_dir(words[project]);
    int   has_main = bta_project_has_main(dir);

    if (has_main == 0) {
        char *gui = find_gui_host();

        if (!gui) {
            char *name = g_path_get_basename(dir);

            fprintf(stderr, "bintana: '%s' opens a window, and no "
                            "graphical host is beside this binary. Install "
                            "bintana-gui there, or set BINTANA_GUI to it.\n",
                    name);
            g_free(name);
            g_free(dir);
            return 2;
        }
        g_free(dir);
        return exec_gui(gui, words, nwords);
    }

    g_free(dir);

    if (has_main < 0)
        /* The full parser's diagnosis is the useful one; no option is worth
         * reading for a manifest that cannot be read. */
        return run_project(nwords - project, words + project, false, false, NULL);

    /* The graphical host owns the look and the form options, even for a
     * `main`: `--theme` is `Application.Theme` there, and `--form` is its own
     * refusal. A profile, strictness and the debugger belong to this run. */
    const char *profile = NULL;
    bool        look    = false;

    for (int i = 0; i < project; i++) {
        if (!strcmp(words[i], "--debug")) {
            bta_debug_want();
        } else if (!strcmp(words[i], "--strict")) {
            /* No widgets, so there is nothing to make strict. The graphical
             * console path accepts it for the same reason. */
        } else if (!strcmp(words[i], "--privileged")) {
            /* The helper side of `Privilege.Run`: pkexec started this host
             * with it. Refused unless the process really is elevated, as the
             * graphical host refuses it (main.c). */
            if (!bta_privilege_elevated()) {
                fputs("bintana: --privileged must be run elevated\n", stderr);
                return 2;
            }
        } else if (!strcmp(words[i], "--profile")) {
            if (i + 1 >= project) {
                fprintf(stderr, "bintana: --profile needs a file\n");
                return 2;
            }
            profile = words[++i];
        } else if (is_look_option(words[i])) {
            look = true;
            break;
        } else {
            fprintf(stderr, "bintana: unknown option '%s'\n", words[i]);
            usage();
            return 2;
        }
    }

    if (look) {
        char *gui = find_gui_host();

        if (!gui) {
            fprintf(stderr, "bintana: this run needs the graphical host, and "
                            "none is beside this binary. Install bintana-gui "
                            "there, or set BINTANA_GUI to it.\n");
            return 2;
        }
        return exec_gui(gui, words, nwords);
    }

    if (profile && !bta_profile_start(profile))
        return 2;

    int rc = run_project(nwords - project, words + project, false, false, NULL);

    bta_profile_finish();
    return rc;
}
