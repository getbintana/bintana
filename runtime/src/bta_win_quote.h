/*
 * One Windows command-line argument, quoted -- shared by `bintana-exec`
 * (runtime/src/bta_exec_win32.c) and the suite's private desktop
 * (tests/win-desktop.c). Neither links GLib, so neither can borrow a quoter,
 * and the two copies had already been fixed apart once: this is the one.
 *
 * Quoted the way CommandLineToArgvW and the CRT read it back.
 * **An empty argument is `""`**, or it vanishes: `git commit -m ""` reached
 * git one argument short.  **Backslashes before the closing quote are
 * doubled**, or `"C:\My dir\"` reads as `C:\My dir"` with the quote escaped.
 * Backslashes anywhere else are literal.  The caller sizes `out` at twice the
 * argument plus four, which covers both, and `out` is NUL-terminated.
 */
#ifndef BTA_WIN_QUOTE_H
#define BTA_WIN_QUOTE_H

#include <wchar.h>

static void bta_win_append_quoted(wchar_t *out, const wchar_t *arg)
{
    const wchar_t *p = arg;
    int            quote = *arg == 0;

    for (const wchar_t *q = arg; *q; q++)
        if (*q == L' ' || *q == L'\t' || *q == L'"')
            quote = 1;
    if (quote)
        wcscat(out, L"\"");
    while (*p) {
        int backslashes = 0;

        while (*p == L'\\') {
            backslashes++;
            p++;
        }
        if (*p == L'"' || (*p == 0 && quote)) {
            int count = backslashes * 2 + (*p == L'"');

            for (int i = 0; i < count; i++)
                wcscat(out, L"\\");
            if (*p == L'"') {
                wcscat(out, L"\"");
                p++;
            }
        } else {
            for (int i = 0; i < backslashes; i++)
                wcscat(out, L"\\");
            if (*p) {
                wchar_t one[2] = { *p++, 0 };
                wcscat(out, one);
            }
        }
    }
    if (quote)
        wcscat(out, L"\"");
}

#endif
