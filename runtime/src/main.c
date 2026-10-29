/*
 * bintana -- the Bintana runtime.
 *
 *   bintana [run] <project-dir>
 */
#include "bta.h"

#include <locale.h>
#include <stdio.h>
#include <string.h>

#ifdef G_OS_WIN32
#include <windows.h>
#endif

static void usage(void)
{
    fputs("usage: bintana [run] <project-dir> [args...]\n"
          "       bintana test [--json] <project-dir> [filter]\n"
          "\n"
          "Runs the Bintana project in <project-dir>: evaluates its .js\n"
          "sources, then instantiates and shows the startup form named in\n"
          "project.json.  A project that declares \"main\" instead calls that\n"
          "function and opens no display at all.  Anything after the directory\n"
          "is handed to the project as Application.Arguments.\n"
          "\n"
          "  --version print the runtime's own release and exit.  An\n"
          "            application's version is Application.Version, and the\n"
          "            protocol a plugin speaks is BTA_PLUGIN_ABI.\n"
          "  --debug   stop and wait for a debugger before the project runs.\n"
          "            Events go out on descriptor 3 and commands come in on\n"
          "            stdin; the IDE is what speaks it.\n"
          "  --strict  a control refuses a property its class does not have,\n"
          "            so a misspelt name throws where it is written instead\n"
          "            of doing nothing forever.  For development: an\n"
          "            application that keeps state on a control will throw.\n"
          "  --profile <file>  write a Sysprof capture of the runtime's own\n"
          "            marks to <file>, with no Sysprof installed.  Running\n"
          "            under `sysprof-cli` or the Sysprof application instead\n"
          "            needs no flag and carries the samples too.\n"
          "  --form <Class>  open that form instead of project.json's\n"
          "            \"startup\", and as an instance of its own even if the\n"
          "            project is single-instance.  How one dialog is looked\n"
          "            at without walking the program to it.\n"
          "  --text-scale <factor>  text as the desktop's Large Text makes\n"
          "            it: 1.25, 1.5, 2.  Between 0.5 and 4.\n"
          "  --theme dark|light  the theme's dark or light variant.\n"
          "  --rtl     lay out right to left, as an Arabic or Hebrew\n"
          "            desktop would.\n"
          "\n"
          "`bintana test` runs the project's tests/*Test.js instead: each\n"
          "file a class extending Test, each method named test... one test.\n"
          "Only the tests whose Class.method contains <filter> run.  It ends\n"
          "0 when every test passed and 1 when one did not.\n"
          "  --json    one JSON line per test, and one at the end.\n",
          stderr);
}

int main(int argc, char **argv)
{
    /*
     * The desktop's locale, asked for before anything writes a number a person
     * will read.
     *
     * GTK calls this itself, which is why nothing needed it until now -- and why
     * a **console** project got the C locale instead, spelling `Locale.Date` as
     * `08/31/26` with English month names on a Spanish desktop.  One line here
     * and the two branches agree; GTK calling it again is harmless.
     *
     * Nothing that produces *machine* text depends on the C locale being in
     * force: the CSS the widgets write goes through `g_ascii_formatd`, and the
     * Plural-Forms header is parsed a digit at a time, both for exactly this
     * reason.  See the note above `Locale.Number` in bta_locale.c.
     */
    setlocale(LC_ALL, "");

#ifdef G_OS_WIN32
    /*
     * And the console's own code page, which is not UTF-8 by default: without
     * this every line this program prints -- `print`, `Logger`, a traceback --
     * reaches a Windows terminal as mojibake, and the suite's output is
     * unreadable in exactly the place it exists to be read from.
     */
    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCP(CP_UTF8);

    /*
     * **The desktop's own title bar, as on Linux.** GTK4 draws every decorated
     * window's title bar and frame itself on Windows unless `GTK_CSD` is "0"
     * (`gtk_window_should_use_csd` in gtkwindow.c) -- the opposite of its X11
     * default -- so an application came up wearing a GNOME header bar, without
     * the system's colours, snap layouts or window menu. Asked for here, before
     * the first window exists, because GTK reads it as each one is made; and
     * only when unset, so `GTK_CSD=1` still gets GTK's own.
     */
    g_setenv("GTK_CSD", "0", FALSE);
#endif

    const char *dir  = NULL;
    const char *profile = NULL;
    const char *form = NULL;
    bool        testing = false;
    bool        json = false;
    const char *theme = NULL;
    double      text_scale = 0;
    bool        rtl = false;
    GPtrArray  *rest = g_ptr_array_new();

    for (int i = 1; i < argc; i++) {
        if (!dir && !strcmp(argv[i], "run"))
            continue;
        /* `bintana test <project> [filter]`: the project's tests instead of
         * the project. A word and not an option, like `run`, because it says
         * what to do rather than how. */
        if (!dir && !testing && !strcmp(argv[i], "test")) {
            testing = true;
            continue;
        }
        if (!dir && !strcmp(argv[i], "--json")) {
            json = true;
            continue;
        }
        if (!dir && (!strcmp(argv[i], "-h") || !strcmp(argv[i], "--help"))) {
            usage();
            g_ptr_array_unref(rest);
            return 0;
        }
        /*
         * The runtime's version, which had no way out of the binary: it was a
         * JS global and a line in bintana.pc, so a script, a packager or a
         * plugin's configure had to start a project to ask. See BTA_VERSION_STRING.
         */
        if (!dir && !strcmp(argv[i], "--version")) {
            printf("bintana %s\n", BTA_VERSION_STRING);
            g_ptr_array_unref(rest);
            return 0;
        }
        /* Debugging is asked for before the project, like every other option,
         * and what it does is in runtime/src/bta_debug.c. */
        if (!dir && !strcmp(argv[i], "--debug")) {
            bta_debug_want();
            continue;
        }
        /*
         * A property of the **run** and not of the project, which is why it is
         * here and not in project.json: the same project is run under it and
         * not under it, and what decides is whoever pressed the button.
         */
        if (!dir && !strcmp(argv[i], "--strict")) {
            bta_strict_want();
            continue;
        }
        /*
         * `--profile <file>` takes its argument, so the option and the path
         * must sit together before the project (the first bare word is the
         * project; anything after it belongs to the project).
         */
        if (!dir && !strcmp(argv[i], "--profile")) {
            if (i + 1 >= argc) {
                fprintf(stderr, "bintana: --profile needs a file\n");
                usage();
                g_ptr_array_unref(rest);
                return 2;
            }
            profile = argv[++i];
            continue;
        }
        /*
         * How the run is to look, and where it starts: each a property of the
         * run and not of the project, for `--strict`'s reason. The IDE's
         * preview is these four; see `apply_look` in bta_runtime.c.
         */
        if (!dir && (!strcmp(argv[i], "--form") || !strcmp(argv[i], "--text-scale") ||
                     !strcmp(argv[i], "--theme"))) {
            if (i + 1 >= argc) {
                fprintf(stderr, "bintana: %s needs a value\n", argv[i]);
                g_ptr_array_unref(rest);
                return 2;
            }
            const char *opt = argv[i], *val = argv[++i];
            if (!strcmp(opt, "--form")) {
                form = val;
            } else if (!strcmp(opt, "--theme")) {
                if (strcmp(val, "dark") && strcmp(val, "light")) {
                    fprintf(stderr, "bintana: --theme is dark or light, not '%s'\n", val);
                    g_ptr_array_unref(rest);
                    return 2;
                }
                theme = val;
            } else {
                char *end = NULL;
                text_scale = g_ascii_strtod(val, &end);
                if (!end || *end || !(text_scale >= 0.5 && text_scale <= 4)) {
                    fprintf(stderr, "bintana: --text-scale is a number between 0.5 "
                                    "and 4, not '%s'\n", val);
                    g_ptr_array_unref(rest);
                    return 2;
                }
            }
            continue;
        }
        if (!dir && !strcmp(argv[i], "--rtl")) {
            rtl = true;
            continue;
        }
        if (!dir && argv[i][0] == '-') {
            fprintf(stderr, "bintana: unknown option '%s'\n", argv[i]);
            g_ptr_array_unref(rest);
            return 2;
        }
        /* First bare word is the project; the rest belongs to the project. */
        if (!dir)
            dir = argv[i];
        else
            g_ptr_array_add(rest, argv[i]);
    }
    g_ptr_array_add(rest, NULL);

    if (!dir) {
        usage();
        g_ptr_array_unref(rest);
        return 2;
    }
    if (!g_file_test(dir, G_FILE_TEST_IS_DIR)) {
        fprintf(stderr, "bintana: '%s' is not a directory\n", dir);
        g_ptr_array_unref(rest);
        return 2;
    }

    if (!bta_profile_start(profile)) {
        g_ptr_array_unref(rest);
        return 2;
    }

    BtaApp *app = bta_app_new(dir);
    app->args = (char **)rest->pdata;

    if (form) {
        if (app->entry) {
            fprintf(stderr, "bintana: --form opens a form, and this project "
                            "declares \"main\": it has none to open\n");
            bta_app_free(app);
            bta_profile_finish();
            g_ptr_array_unref(rest);
            return 2;
        }
        /* A form looked at on its own is not *the* program started again: a
         * single-instance project would hand it to the running one, which
         * would raise its own window and open nothing. */
        g_free(app->startup);
        app->startup = g_strdup(form);
        app->single  = false;
    }
    if (json && !testing) {
        fprintf(stderr, "bintana: --json is for `bintana test`\n");
        bta_app_free(app);
        bta_profile_finish();
        g_ptr_array_unref(rest);
        return 2;
    }
    if (testing) {
        app->testing     = true;
        app->test_json   = json;
        app->test_filter = rest->len > 1 ? g_strdup(rest->pdata[0]) : NULL;
        app->single      = false;
    }
    app->text_scale = text_scale;
    app->theme      = g_strdup(theme);
    app->rtl        = rtl;

    /* GApplication would try to parse our arguments as its own. */
    char *fake_argv[] = { argv[0], NULL };
    int   rc = bta_app_run(app, 1, fake_argv);

    bta_app_free(app);
    bta_profile_finish();
    g_ptr_array_unref(rest);   /* holds argv pointers, not copies */
    return rc;
}
