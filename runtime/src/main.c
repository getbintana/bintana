/*
 * bintana -- the Bintana runtime.
 *
 *   bintana [run] <project-dir>
 */
#include "bta.h"

#include <locale.h>
#include <stdio.h>
#include <string.h>

static void usage(void)
{
    fputs("usage: bintana [run] <project-dir> [args...]\n"
          "\n"
          "Runs the Bintana project in <project-dir>: evaluates its .js\n"
          "sources, then instantiates and shows the startup form named in\n"
          "project.json.  A project that declares \"main\" instead calls that\n"
          "function and opens no display at all.  Anything after the directory\n"
          "is handed to the project as Application.Arguments.\n", stderr);
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

    const char *dir  = NULL;
    GPtrArray  *rest = g_ptr_array_new();

    for (int i = 1; i < argc; i++) {
        if (!dir && !strcmp(argv[i], "run"))
            continue;
        if (!dir && (!strcmp(argv[i], "-h") || !strcmp(argv[i], "--help"))) {
            usage();
            g_ptr_array_unref(rest);
            return 0;
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

    BtaApp *app = bta_app_new(dir);
    app->args = (char **)rest->pdata;

    /* GApplication would try to parse our arguments as its own. */
    char *fake_argv[] = { argv[0], NULL };
    int   rc = bta_app_run(app, 1, fake_argv);

    bta_app_free(app);
    g_ptr_array_unref(rest);   /* holds argv pointers, not copies */
    return rc;
}
