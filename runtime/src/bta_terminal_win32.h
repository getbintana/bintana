/*
 * The Windows terminal backend: ConPTY for the child and libvterm for the
 * screen.
 *
 * `bta_terminal.c` owns the public surface and the VTE backend; this file is
 * the implementation of the same handful of calls a build without VTE would
 * otherwise refuse.  It is only compiled on Windows and only does anything
 * when CMake found libvterm -- VTE has no Windows port, and ConPTY needs an
 * escape-sequence interpreter of its own.
 */
#ifndef BTA_TERMINAL_WIN32_H
#define BTA_TERMINAL_WIN32_H

#include "bta.h"

#ifdef G_OS_WIN32

void   bta_terminal_win32_build(BtaWidget *w);
bool   bta_terminal_win32_spawn(JSContext *ctx, BtaWidget *w, char **argv,
                                const char *cwd);
bool   bta_terminal_win32_alive(BtaWidget *w);
void   bta_terminal_win32_write(BtaWidget *w, const char *s, size_t len);
void   bta_terminal_win32_reset(BtaWidget *w);
char  *bta_terminal_win32_read(BtaWidget *w);
bool   bta_terminal_win32_pattern(JSContext *ctx, BtaWidget *w,
                                  const char *pattern);
bool   bta_terminal_win32_kill(BtaWidget *w, bool hard);

int    bta_terminal_win32_get_scrollback(BtaWidget *w);
void   bta_terminal_win32_set_scrollback(BtaWidget *w, int n);
double bta_terminal_win32_get_font_scale(BtaWidget *w);
void   bta_terminal_win32_set_font_scale(BtaWidget *w, double scale);

#endif /* G_OS_WIN32 */

#endif /* BTA_TERMINAL_WIN32_H */
