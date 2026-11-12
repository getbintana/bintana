/*
 * Terminal on Windows: ConPTY for the child, libvterm for the screen.
 *
 * `bta_terminal.c` keeps the public surface, the property table and the VTE
 * implementation; this file is the Windows answer to the same handful of
 * calls.  The two halves of the job are separate on purpose:
 *
 *   ConPTY (Windows 10 1809+) gives the child a real console -- input, output
 *   and window size -- so a shell, `ssh`, `vim` or a compiler's progress bar
 *   behave as they do in any other terminal.  The pipes are UTF-8 and carry
 *   VT sequences, not structured console events.
 *
 *   libvterm interprets those sequences into a grid of cells.  It is a
 *   library and not GTK: what is drawn, how a key is encoded and how much
 *   history is kept are this file's business.  VTE, the Linux answer, brings
 *   its own widget; there is no such thing on Windows.
 *
 * The control is a `GtkDrawingArea` and a `GtkScrollbar` in a box.  A
 * `GtkTextView` would be the fallback's shape and would not do: a terminal is
 * a fixed grid, a cursor and cells with colours, not a wrapped text buffer.
 *
 * The child is read on a thread because Windows pipes have no GLib pollable
 * stream.  The thread never touches libvterm or GTK: it appends bytes to a
 * queue and schedules an idle, and every parse, draw and JavaScript event
 * happens on the main loop.  The terminal's lifetime is a reference count
 * shared by the view, the reader and the waiter, so a child outliving the
 * widget that started it is dropped, not written into freed memory.
 */
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00        /* CreatePseudoConsole and friends */
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include "bta.h"
#include "bta_terminal_win32.h"

#if defined(G_OS_WIN32) && defined(BTA_HAVE_LIBVTERM)

#include <windows.h>
#include <vterm.h>

#include <string.h>
#include <wchar.h>

#define TERM_VIEW_KEY "bta-terminal-view"

/* A box that calls itself `scrolledwindow`.
 *
 * `Terminal.CssNode()` is `scrolledwindow` on every platform -- the test names
 * it, the theme styles it, and a `.form` author may select it.  Linux's VTE is
 * inside a real `GtkScrolledWindow`; the Windows half cannot be, because its
 * vertical scrollbar is a sibling of the drawing area rather than GTK's
 * adjustment.  The layout is still a box; only the CSS node's name is the
 * contract. */
typedef struct {
    GtkBox parent_instance;
} BtaTermBox;

typedef struct {
    GtkBoxClass parent_class;
} BtaTermBoxClass;

G_DEFINE_TYPE(BtaTermBox, bta_term_box, GTK_TYPE_BOX)

static void bta_term_box_class_init(BtaTermBoxClass *klass)
{
    gtk_widget_class_set_css_name(GTK_WIDGET_CLASS(klass), "scrolledwindow");
}

static void bta_term_box_init(BtaTermBox *self)
{
    gtk_orientable_set_orientation(GTK_ORIENTABLE(self),
                                   GTK_ORIENTATION_HORIZONTAL);
}

/* ------------------------------------------------------------- the colours */

typedef struct {
    guint8 r, g, b;
} TermRgb;

static const TermRgb TERM_BG = { 0x0c, 0x0c, 0x0c };
static const TermRgb TERM_FG = { 0xcc, 0xcc, 0xcc };
static const TermRgb TERM_SELECTION = { 0x26, 0x4f, 0x78 };

static const TermRgb TERM_PALETTE[16] = {
    { 0x00, 0x00, 0x00 }, { 0xcd, 0x00, 0x00 },
    { 0x00, 0xcd, 0x00 }, { 0xcd, 0xcd, 0x00 },
    { 0x00, 0x00, 0xee }, { 0xcd, 0x00, 0xcd },
    { 0x00, 0xcd, 0xcd }, { 0xe5, 0xe5, 0xe5 },
    { 0x7f, 0x7f, 0x7f }, { 0xff, 0x00, 0x00 },
    { 0x00, 0xff, 0x00 }, { 0xff, 0xff, 0x00 },
    { 0x5c, 0x5c, 0xff }, { 0xff, 0x00, 0xff },
    { 0x00, 0xff, 0xff }, { 0xff, 0xff, 0xff },
};

static TermRgb term_palette(int index)
{
    static const guint8 steps[6] = { 0, 95, 135, 175, 215, 255 };

    if (index < 0)
        index = 0;
    if (index < 16)
        return TERM_PALETTE[index];
    if (index < 232) {
        int n = index - 16;

        return (TermRgb){ steps[n / 36], steps[(n / 6) % 6], steps[n % 6] };
    }
    {
        guint8 grey = (guint8)(8 + (index - 232) * 10);

        return (TermRgb){ grey, grey, grey };
    }
}

static TermRgb term_color(VTermColor color, bool foreground, bool bold)
{
    if (VTERM_COLOR_IS_DEFAULT_FG(&color))
        return TERM_FG;
    if (VTERM_COLOR_IS_DEFAULT_BG(&color))
        return TERM_BG;
    if (VTERM_COLOR_IS_INDEXED(&color)) {
        int index = color.indexed.idx;

        if (foreground && bold && index < 8)
            index += 8;
        return term_palette(index);
    }
    return (TermRgb){ color.rgb.red, color.rgb.green, color.rgb.blue };
}

static void term_set_color(cairo_t *cr, TermRgb color)
{
    cairo_set_source_rgb(cr, color.r / 255.0, color.g / 255.0, color.b / 255.0);
}

/* --------------------------------------------------------------- the models */

typedef struct {
    VTermScreenCell *cells;
    int              cols;
} TermLine;

static void term_line_free(gpointer p)
{
    TermLine *line = p;

    if (!line)
        return;
    g_free(line->cells);
    g_free(line);
}

typedef struct TermView TermView;
typedef struct WinTerm  WinTerm;

struct WinTerm {
    gint     refs;
    GMutex   lock;

    TermView *tv;                 /* weak; guarded by `lock`, NULL once detached */

    HPCON    hpc;
    HANDLE   in_write;
    HANDLE   out_read;
    HANDLE   process;
    HANDLE   job;
    HANDLE   reader;
    HANDLE   waiter;

    gint     alive;               /* atomic */
    bool     closing;             /* guarded by `lock` */
    GByteArray *pending;          /* guarded by `lock` */
    bool     idle_scheduled;      /* guarded by `lock` */
};

struct TermView {
    gint     refs;

    GtkWidget      *area;         /* weak while the GtkWidget owns this struct */
    GtkWidget      *outer;        /* the box; it carries BTA_WIDGET_QUARK */
    GtkWidget      *bar;
    GtkAdjustment  *adj;

    VTerm          *vt;
    VTermScreen    *screen;
    VTermState     *state;

    PangoLayout         *layout;
    PangoFontDescription *font;
    PangoFontDescription *font_bold;
    PangoFontDescription *font_italic;
    PangoFontDescription *font_bold_italic;
    int                   cell_w, cell_h;

    int      rows, cols;
    VTermScreenCell *scratch;
    int      scratch_cols;

    int      scrollback_lines;
    GQueue  *scrollback;
    int      scroll_offset;

    double   font_scale;
    bool     updating_bar;

    bool     cursor_visible;
    int      cursor_shape;
    int      mouse_mode;
    int      alt_screen;
    bool     focused;

    /* ConPTY announces win32-input-mode with `CSI ? 9001 h`.  The scanner is a
     * prefix match across reads, because a pipe read may split the sequence. */
    bool     win32_input;
    int      win32_match;

    GtkIMContext *im;

    GRegex  *link;
    char    *hover;
    char    *pressed_link;

    bool     selecting;
    bool     press_moved;
    int      sel_start_row, sel_start_col;
    int      sel_end_row, sel_end_col;
    int      pointer_row, pointer_col;
    int      mouse_down;

    WinTerm *io;
    guint    generation;
};

/* -------------------------------------------------------------- references */

static TermView *term_view_ref(TermView *tv)
{
    g_atomic_int_inc(&tv->refs);
    return tv;
}

static void term_view_unref(TermView *tv);

static WinTerm *winterm_ref(WinTerm *wt)
{
    g_atomic_int_inc(&wt->refs);
    return wt;
}

static void winterm_unref(WinTerm *wt);

static void winterm_unref_notify(gpointer p)
{
    winterm_unref(p);
}

/* --------------------------------------------------------------- the screen */

static void term_view_queue_draw(TermView *tv)
{
    if (tv->area)
        gtk_widget_queue_draw(tv->area);
}

/* The runtime tags the control's outermost widget, not its inner one: a
 * Terminal's `inner` is the drawing area and its `gtk` is the box around it.
 * Events are raised on the wrapper, and the box is the only object that can be
 * asked for it. */
static BtaWidget *term_view_widget(TermView *tv)
{
    if (!tv->outer)
        return NULL;
    return g_object_get_data(G_OBJECT(tv->outer), BTA_WIDGET_QUARK);
}

static void term_view_update_bar(TermView *tv)
{
    int sb, rows, offset;

    if (!tv->adj)
        return;

    sb     = (int)g_queue_get_length(tv->scrollback);
    rows   = MAX(1, tv->rows);
    offset = CLAMP(tv->scroll_offset, 0, sb);
    tv->scroll_offset = offset;

    tv->updating_bar = true;
    gtk_adjustment_configure(tv->adj,
                             (double)(sb - offset), 0.0,
                             (double)(sb + rows),
                             1.0, (double)rows, (double)rows);
    tv->updating_bar = false;
}

static void term_view_trim_scrollback(TermView *tv)
{
    int limit = tv->scrollback_lines < 0 ? G_MAXINT : tv->scrollback_lines;

    while ((int)g_queue_get_length(tv->scrollback) > limit)
        term_line_free(g_queue_pop_head(tv->scrollback));

    if (tv->scroll_offset > (int)g_queue_get_length(tv->scrollback))
        tv->scroll_offset = (int)g_queue_get_length(tv->scrollback);
}

static int term_sb_pushline(int cols, const VTermScreenCell *cells, void *user)
{
    TermView *tv  = user;
    int       limit = tv->scrollback_lines < 0 ? G_MAXINT
                                                : tv->scrollback_lines;

    if (limit <= 0)
        return 1;

    TermLine *line = g_new0(TermLine, 1);

    line->cols  = cols;
    line->cells = g_new0(VTermScreenCell, cols > 0 ? cols : 1);
    if (cols > 0)
        memcpy(line->cells, cells, (size_t)cols * sizeof(VTermScreenCell));
    g_queue_push_tail(tv->scrollback, line);
    term_view_trim_scrollback(tv);
    term_view_update_bar(tv);
    return 1;
}

static int term_sb_popline(int cols, VTermScreenCell *cells, void *user)
{
    (void)cols;
    (void)cells;
    (void)user;
    return 0;                 /* the history is ours to draw, not libvterm's */
}

static int term_sb_clear(void *user)
{
    TermView *tv = user;

    while (!g_queue_is_empty(tv->scrollback))
        term_line_free(g_queue_pop_head(tv->scrollback));
    tv->scroll_offset = 0;
    term_view_update_bar(tv);
    return 1;
}

static int term_damage(VTermRect rect, void *user)
{
    (void)rect;
    term_view_queue_draw(user);
    return 1;
}

static int term_moverect(VTermRect dest, VTermRect src, void *user)
{
    (void)dest;
    (void)src;
    term_view_queue_draw(user);
    return 1;
}

static int term_movecursor(VTermPos pos, VTermPos oldpos, int visible, void *user)
{
    (void)pos;
    (void)oldpos;
    (void)visible;
    term_view_queue_draw(user);
    return 1;
}

static int term_settermprop(VTermProp prop, VTermValue *val, void *user)
{
    TermView *tv = user;

    switch (prop) {
    case VTERM_PROP_CURSORVISIBLE:
        tv->cursor_visible = val->boolean != 0;
        break;
    case VTERM_PROP_CURSORSHAPE:
        tv->cursor_shape = val->number;
        break;
    case VTERM_PROP_ALTSCREEN:
        tv->alt_screen = val->boolean != 0;
        break;
    case VTERM_PROP_MOUSE:
        tv->mouse_mode = val->number;
        break;
    default:
        return 0;
    }
    term_view_queue_draw(tv);
    return 1;
}

static int term_bell(void *user)
{
    TermView *tv = user;

    if (tv->area)
        gtk_widget_error_bell(tv->area);
    return 1;
}

static int term_resize(int rows, int cols, void *user)
{
    (void)rows;
    (void)cols;
    term_view_queue_draw(user);
    return 1;
}

static const VTermScreenCallbacks term_screen_callbacks = {
    .damage      = term_damage,
    .moverect    = term_moverect,
    .movecursor  = term_movecursor,
    .settermprop = term_settermprop,
    .bell        = term_bell,
    .resize      = term_resize,
    .sb_pushline = term_sb_pushline,
    .sb_popline  = term_sb_popline,
    .sb_clear    = term_sb_clear,
};

/* ---------------------------------------------------------------- the font */

static void term_metrics(TermView *tv)
{
    PangoFontMetrics *metrics;
    PangoContext     *context;
    double            scale;

    if (!tv->area)
        return;

    scale = CLAMP(tv->font_scale, 0.05, 20.0);

    g_clear_pointer(&tv->font, pango_font_description_free);
    g_clear_pointer(&tv->font_bold, pango_font_description_free);
    g_clear_pointer(&tv->font_italic, pango_font_description_free);
    g_clear_pointer(&tv->font_bold_italic, pango_font_description_free);

    tv->font = pango_font_description_from_string("Monospace");
    pango_font_description_set_size(tv->font,
                                    (int)(10 * PANGO_SCALE * scale));

    tv->font_bold = pango_font_description_copy(tv->font);
    pango_font_description_set_weight(tv->font_bold, PANGO_WEIGHT_BOLD);

    tv->font_italic = pango_font_description_copy(tv->font);
    pango_font_description_set_style(tv->font_italic, PANGO_STYLE_ITALIC);

    tv->font_bold_italic = pango_font_description_copy(tv->font_bold);
    pango_font_description_set_style(tv->font_bold_italic, PANGO_STYLE_ITALIC);

    context = gtk_widget_get_pango_context(tv->area);
    metrics = pango_context_get_metrics(context, tv->font, NULL);

    tv->cell_w = MAX(1, PANGO_PIXELS_CEIL(
        pango_font_metrics_get_approximate_char_width(metrics)));
    tv->cell_h = MAX(1, PANGO_PIXELS_CEIL(
        pango_font_metrics_get_height(metrics)));
    if (tv->cell_h < tv->cell_w)
        tv->cell_h = tv->cell_w;      /* a font with no vertical metrics */

    pango_font_metrics_unref(metrics);

    if (!tv->layout)
        tv->layout = gtk_widget_create_pango_layout(tv->area, NULL);
    pango_layout_set_wrap(tv->layout, PANGO_WRAP_NONE);
    pango_layout_set_font_description(tv->layout, tv->font);
}

/* --------------------------------------------------------------- the child */

static void winterm_write(WinTerm *wt, const char *s, size_t len)
{
    DWORD wrote;

    if (!wt || !wt->in_write || len == 0)
        return;
    WriteFile(wt->in_write, s, (DWORD)len, &wrote, NULL);
}

static void term_output_cb(const char *s, size_t len, void *user)
{
    TermView *tv = user;

    winterm_write(tv->io, s, len);
}

/* Finds the `CSI ? 9001 h` / `l` in the byte stream before libvterm sees it.
 * Nothing in libvterm 0.3 knows that private mode, and ignoring it is right for
 * the screen; this only decides how a key is encoded on the way back. */
static void term_scan_modes(TermView *tv, const char *s, size_t len)
{
    static const char marker[] = "\x1b[?9001";

    for (size_t i = 0; i < len; i++) {
        char c = s[i];

        if (tv->win32_match == (int)sizeof(marker) - 1) {
            if (c == 'h' || c == 'l') {
                tv->win32_input = c == 'h';
                tv->win32_match = 0;
                continue;
            }
            tv->win32_match = c == '\x1b' ? 1 : 0;
            continue;
        }
        if (c == marker[tv->win32_match]) {
            tv->win32_match++;
        } else {
            tv->win32_match = c == '\x1b' ? 1 : 0;
        }
    }
}

static void term_view_feed(TermView *tv, const char *s, size_t len)
{
    size_t done = 0;

    if (!tv->vt || !s || !len)
        return;

    term_scan_modes(tv, s, len);

    while (done < len) {
        size_t n = vterm_input_write(tv->vt, s + done, len - done);

        if (n == 0)
            break;
        done += n;
    }
    vterm_screen_flush_damage(tv->screen);
    term_view_update_bar(tv);
    term_view_queue_draw(tv);
}

static void term_winterm_drain(WinTerm *wt, TermView *tv)
{
    GByteArray *pending;

    g_mutex_lock(&wt->lock);
    pending     = wt->pending;
    wt->pending = g_byte_array_new();
    g_mutex_unlock(&wt->lock);

    if (pending->len)
        term_view_feed(tv, (const char *)pending->data, pending->len);
    g_byte_array_unref(pending);
}

static gboolean term_output_idle(gpointer data)
{
    WinTerm  *wt = data;
    TermView *tv = NULL;

    g_mutex_lock(&wt->lock);
    wt->idle_scheduled = false;
    if (!wt->closing && wt->tv)
        tv = term_view_ref(wt->tv);
    if (!tv)
        g_byte_array_set_size(wt->pending, 0);
    g_mutex_unlock(&wt->lock);

    if (tv) {
        if (tv->io == wt)
            term_winterm_drain(wt, tv);
        term_view_unref(tv);
    }
    return G_SOURCE_REMOVE;
}

typedef struct {
    WinTerm *wt;
    int      code;
} ExitEvent;

static void exit_event_free(gpointer p)
{
    ExitEvent *e = p;

    winterm_unref(e->wt);
    g_free(e);
}

static gboolean term_exit_idle(gpointer data)
{
    ExitEvent *e  = data;
    WinTerm   *wt = e->wt;
    TermView  *tv = NULL;

    g_mutex_lock(&wt->lock);
    if (!wt->closing && wt->tv)
        tv = term_view_ref(wt->tv);
    g_mutex_unlock(&wt->lock);

    if (tv) {
        if (tv->io == wt) {
            /* The last of what the child wrote before it ended belongs on the
             * screen before the event that says it ended. */
            term_winterm_drain(wt, tv);
            BtaWidget *w = term_view_widget(tv);

            if (w) {
                JSValue arg = JS_NewInt32(w->ctx, e->code);

                bta_emit(w, "Exit", 1, &arg);
                JS_FreeValue(w->ctx, arg);
            }
        }
        term_view_unref(tv);
    }
    return G_SOURCE_REMOVE;
}

static DWORD WINAPI term_reader_thread(LPVOID data)
{
    WinTerm *wt = data;
    HANDLE   out = wt->out_read;
    char     buffer[8192];

    for (;;) {
        DWORD read = 0;
        BOOL  ok;

        ok = ReadFile(out, buffer, sizeof(buffer), &read, NULL);
        if (!ok || read == 0)
            break;

        g_mutex_lock(&wt->lock);
        if (wt->closing) {
            /* Keep draining while the console closes: a pipe that is not read
             * is exactly what makes ClosePseudoConsole wait forever. */
            g_mutex_unlock(&wt->lock);
            continue;
        }
        g_byte_array_append(wt->pending, (const guint8 *)buffer, read);
        bool schedule = !wt->idle_scheduled;

        wt->idle_scheduled = true;
        g_mutex_unlock(&wt->lock);

        if (schedule) {
            g_idle_add_full(G_PRIORITY_DEFAULT, term_output_idle,
                            winterm_ref(wt), winterm_unref_notify);
        }
    }
    winterm_unref(wt);
    return 0;
}

static DWORD WINAPI term_waiter_thread(LPVOID data)
{
    WinTerm *wt = data;
    HANDLE   process = wt->process;
    DWORD    code = 0;

    if (!process) {
        winterm_unref(wt);
        return 0;
    }
    WaitForSingleObject(process, INFINITE);
    GetExitCodeProcess(process, &code);
    g_atomic_int_set(&wt->alive, 0);

    /* The reader does not see end-of-file until the pseudo console is closed,
     * which happens when the terminal goes, so waiting on it here would delay
     * `Exit` by its full timeout.  A short breath lets the last frame arrive;
     * the exit event then drains whatever is already in the queue. */
    if (wt->reader)
        WaitForSingleObject(wt->reader, 50);

    ExitEvent *event = g_new0(ExitEvent, 1);

    event->wt   = winterm_ref(wt);
    if (code == 0xC000013A)            /* STATUS_CONTROL_C_EXIT */
        event->code = 130;
    else if (code > 255)
        event->code = (int)code;
    else
        event->code = (int)code;

    g_idle_add_full(G_PRIORITY_DEFAULT, term_exit_idle, event, exit_event_free);
    winterm_unref(wt);
    return 0;
}

static void winterm_shutdown(WinTerm *wt)
{
    HPCON  hpc;
    HANDLE in_write, out_read, process, job, reader, waiter;

    if (!wt)
        return;

    g_mutex_lock(&wt->lock);
    if (wt->closing) {
        g_mutex_unlock(&wt->lock);
        return;
    }
    wt->closing = true;
    wt->tv      = NULL;

    hpc       = wt->hpc;       wt->hpc       = NULL;
    in_write  = wt->in_write;  wt->in_write  = NULL;
    out_read  = wt->out_read;  wt->out_read  = NULL;
    process   = wt->process;   wt->process   = NULL;
    job       = wt->job;       wt->job       = NULL;
    reader    = wt->reader;    wt->reader    = NULL;
    waiter    = wt->waiter;    wt->waiter    = NULL;
    g_byte_array_set_size(wt->pending, 0);
    g_mutex_unlock(&wt->lock);

    if (process) {
        if (job)
            TerminateJobObject(job, 1);
        else
            TerminateProcess(process, 1);
    }

    if (hpc)
        ClosePseudoConsole(hpc);

    /* Closing the pseudo console closes the conhost end; a read already in
     * flight is cancelled explicitly, because a pipe read does not come back
     * merely because the other handle went away. */
    if (reader) {
        CancelSynchronousIo(reader);
        WaitForSingleObject(reader, 5000);
    }
    if (waiter)
        WaitForSingleObject(waiter, 5000);

    if (in_write)
        CloseHandle(in_write);
    if (out_read)
        CloseHandle(out_read);
    if (process)
        CloseHandle(process);
    if (job)
        CloseHandle(job);
    if (reader)
        CloseHandle(reader);
    if (waiter)
        CloseHandle(waiter);
}

static void winterm_free(WinTerm *wt)
{
    winterm_shutdown(wt);
    g_byte_array_unref(wt->pending);
    g_mutex_clear(&wt->lock);
    g_free(wt);
}

static void winterm_unref(WinTerm *wt)
{
    if (g_atomic_int_dec_and_test(&wt->refs))
        winterm_free(wt);
}

/* ------------------------------------------------------------ the command */

static wchar_t *term_utf16(const char *s)
{
    if (!s)
        return NULL;
    return g_utf8_to_utf16(s, -1, NULL, NULL, NULL);
}

static wchar_t *term_wcsdup(const wchar_t *s)
{
    size_t   len = wcslen(s) + 1;
    wchar_t *out = g_new(wchar_t, len);

    memcpy(out, s, len * sizeof(wchar_t));
    return out;
}

static void term_quote_arg(GString *cmd, const char *arg)
{
    const char *p;
    bool        quote = !*arg || strpbrk(arg, " \t\n\v\"") != NULL;

    if (!quote) {
        g_string_append(cmd, arg);
        return;
    }

    g_string_append_c(cmd, '"');
    for (p = arg; ; p++) {
        size_t backslashes = 0;

        while (*p == '\\') {
            backslashes++;
            p++;
        }
        if (*p == '\0') {
            for (size_t i = 0; i < backslashes * 2; i++)
                g_string_append_c(cmd, '\\');
            g_string_append_c(cmd, '"');
            break;
        }
        if (*p == '"') {
            for (size_t i = 0; i < backslashes * 2 + 1; i++)
                g_string_append_c(cmd, '\\');
            g_string_append_c(cmd, '"');
        } else {
            for (size_t i = 0; i < backslashes; i++)
                g_string_append_c(cmd, '\\');
            g_string_append_c(cmd, *p);
        }
    }
}

static char *term_command_line(char **argv)
{
    GString *cmd = g_string_new(NULL);

    for (int i = 0; argv[i]; i++) {
        if (i)
            g_string_append_c(cmd, ' ');
        term_quote_arg(cmd, argv[i]);
    }
    return g_string_free(cmd, FALSE);
}

static gint term_env_cmp(gconstpointer a, gconstpointer b)
{
    const wchar_t *sa = *(const wchar_t * const *)a;
    const wchar_t *sb = *(const wchar_t * const *)b;

    return _wcsicmp(sa, sb);
}

static wchar_t *term_environment(void)
{
    LPWCH     block = GetEnvironmentStringsW();
    GPtrArray *items = g_ptr_array_new_with_free_func(g_free);
    wchar_t   *env;
    gsize      size = 1;

    if (block) {
        for (LPWCH p = block; *p; p += wcslen(p) + 1) {
            if (_wcsnicmp(p, L"TERM=", 5) == 0 ||
                _wcsnicmp(p, L"COLORTERM=", 10) == 0)
                continue;
            g_ptr_array_add(items, term_wcsdup(p));
        }
        FreeEnvironmentStringsW(block);
    }

    g_ptr_array_add(items, term_wcsdup(L"TERM=xterm-256color"));
    g_ptr_array_add(items, term_wcsdup(L"COLORTERM=truecolor"));
    g_ptr_array_sort(items, term_env_cmp);

    for (guint i = 0; i < items->len; i++)
        size += wcslen(g_ptr_array_index(items, i)) + 1;

    env = g_new(wchar_t, size);
    {
        wchar_t *at = env;

        for (guint i = 0; i < items->len; i++) {
            const wchar_t *item = g_ptr_array_index(items, i);
            size_t         len  = wcslen(item) + 1;

            memcpy(at, item, len * sizeof(wchar_t));
            at += len;
        }
        *at = L'\0';
    }
    g_ptr_array_unref(items);
    return env;
}

static char *term_win32_error(const char *what)
{
    return g_strdup_printf("%s failed with Windows error %lu", what,
                           (unsigned long)GetLastError());
}

/* ------------------------------------------------------------- the process */

static WinTerm *winterm_create(TermView *tv, char **argv, const char *cwd,
                               char **error)
{
    SECURITY_ATTRIBUTES sa = { sizeof(SECURITY_ATTRIBUTES), NULL, TRUE };
    HANDLE  in_read = NULL, in_write = NULL, out_read = NULL, out_write = NULL;
    HANDLE  job = NULL, process = NULL, thread = NULL;
    HPCON   hpc = NULL;
    char   *command = NULL;
    wchar_t *wcommand = NULL, *wcwd = NULL, *env = NULL;
    STARTUPINFOEXW si;
    PROCESS_INFORMATION pi;
    SIZE_T  attr_size = 0;
    bool    attributes = false;
    WinTerm *wt = NULL;

    *error = NULL;
    ZeroMemory(&si, sizeof(si));
    ZeroMemory(&pi, sizeof(pi));

    command = term_command_line(argv);
    wcommand = term_utf16(command);
    g_free(command);
    if (!wcommand) {
        *error = g_strdup("the command line is not valid UTF-8");
        goto fail;
    }
    if (cwd && *cwd) {
        wcwd = term_utf16(cwd);
        if (!wcwd) {
            *error = g_strdup("the working directory is not valid UTF-8");
            goto fail;
        }
    }
    env = term_environment();

    if (!CreatePipe(&in_read, &in_write, &sa, 0)) {
        *error = term_win32_error("CreatePipe");
        goto fail;
    }
    if (!CreatePipe(&out_read, &out_write, &sa, 0)) {
        *error = term_win32_error("CreatePipe");
        goto fail;
    }
    SetHandleInformation(in_write, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(out_read, HANDLE_FLAG_INHERIT, 0);

    COORD size = { (SHORT)CLAMP(tv->cols, 1, 32767),
                   (SHORT)CLAMP(tv->rows, 1, 32767) };
    HRESULT hr = CreatePseudoConsole(size, in_read, out_write, 0, &hpc);

    CloseHandle(in_read);
    in_read = NULL;
    CloseHandle(out_write);
    out_write = NULL;

    if (FAILED(hr)) {
        *error = g_strdup_printf("CreatePseudoConsole failed (0x%08lx)",
                                 (unsigned long)hr);
        goto fail;
    }

    InitializeProcThreadAttributeList(NULL, 1, 0, &attr_size);
    si.lpAttributeList = g_malloc0(attr_size);
    if (!InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0,
                                           &attr_size)) {
        *error = term_win32_error("InitializeProcThreadAttributeList");
        goto fail;
    }
    attributes = true;
    if (!UpdateProcThreadAttribute(si.lpAttributeList, 0,
                                   PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                                   hpc, sizeof(hpc), NULL, NULL)) {
        *error = term_win32_error("UpdateProcThreadAttribute");
        goto fail;
    }
    si.StartupInfo.cb         = sizeof(si);
    /* **STARTF_USESTDHANDLES with all three zeroed**, which is what Windows
     * Terminal does.  Without it the child inherits this process's stdout and
     * `cmd.exe`'s own `echo` goes there instead of through the pseudo
     * console: measured, the text landed in the parent's redirected stdout
     * while the pipe carried only conhost's opening sequences.  Zeroed
     * handles make the client open `CONIN$`/`CONOUT$`, which is the
     * pseudoconsole. */
    si.StartupInfo.dwFlags    = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.StartupInfo.wShowWindow = SW_HIDE;

    job = CreateJobObjectW(NULL, NULL);
    if (job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;

        ZeroMemory(&limits, sizeof(limits));
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                &limits, sizeof(limits));
    }

    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(NULL, wcommand, NULL, NULL, FALSE,
                        EXTENDED_STARTUPINFO_PRESENT |
                            CREATE_UNICODE_ENVIRONMENT,
                        env, wcwd, &si.StartupInfo, &pi)) {
        *error = term_win32_error("CreateProcess");
        goto fail;
    }
    process = pi.hProcess;
    thread  = pi.hThread;

    /* **Not CREATE_SUSPENDED.** ConPTY connects the child to the pseudo
     * console while starting it; a suspended process is never connected, and
     * its stdout falls back to this process's own handle -- measured: the
     * child's text landed in the parent's redirected stdout and the pipe
     * carried only conhost's opening sequences. */
    if (job)
        AssignProcessToJobObject(job, process);
    CloseHandle(thread);
    thread = NULL;

    wt           = g_new0(WinTerm, 1);
    wt->refs     = 1;
    wt->tv       = tv;
    wt->hpc      = hpc;
    wt->in_write = in_write;
    wt->out_read = out_read;
    wt->process  = process;
    wt->job      = job;
    wt->alive    = 1;
    wt->pending  = g_byte_array_new();
    g_mutex_init(&wt->lock);

    hpc = NULL;
    in_write = out_read = process = job = NULL;
    goto done;

fail:
    if (in_read)
        CloseHandle(in_read);
    if (in_write)
        CloseHandle(in_write);
    if (out_read)
        CloseHandle(out_read);
    if (out_write)
        CloseHandle(out_write);
    if (hpc)
        ClosePseudoConsole(hpc);
    if (process)
        CloseHandle(process);
    if (thread)
        CloseHandle(thread);
    if (job)
        CloseHandle(job);
    if (attributes)
        DeleteProcThreadAttributeList(si.lpAttributeList);
    g_free(si.lpAttributeList);
    g_free(env);
    g_free(wcwd);
    g_free(wcommand);
    return NULL;

done:
    if (attributes)
        DeleteProcThreadAttributeList(si.lpAttributeList);
    g_free(si.lpAttributeList);
    g_free(env);
    g_free(wcwd);
    g_free(wcommand);
    return wt;
}

static bool winterm_start(WinTerm *wt)
{
    wt->reader = CreateThread(NULL, 0, term_reader_thread,
                              winterm_ref(wt), 0, NULL);
    if (!wt->reader) {
        winterm_unref(wt);
        return false;
    }
    wt->waiter = CreateThread(NULL, 0, term_waiter_thread,
                              winterm_ref(wt), 0, NULL);
    if (!wt->waiter) {
        /* The reader is already running; shutdown below closes the pipe and
         * cancels it, and the reference it holds dies with the thread. */
        return false;
    }
    return true;
}

typedef struct {
    TermView *tv;
    guint     generation;
    char     *message;
} Failure;

static void failure_free(gpointer p)
{
    Failure *f = p;

    term_view_unref(f->tv);
    g_free(f->message);
    g_free(f);
}

static gboolean term_failure_idle(gpointer data)
{
    Failure  *f  = data;
    TermView *tv = f->tv;

    if (tv->generation != f->generation || !tv->area)
        return G_SOURCE_REMOVE;

    char *line = g_strdup_printf("\r\n[could not run: %s]\r\n", f->message);

    term_view_feed(tv, line, strlen(line));
    g_free(line);

    BtaWidget *w = term_view_widget(tv);
    if (w) {
        JSValue arg = JS_NewInt32(w->ctx, -1);

        bta_emit(w, "Exit", 1, &arg);
        JS_FreeValue(w->ctx, arg);
    }
    return G_SOURCE_REMOVE;
}

static void term_view_failure(TermView *tv, guint generation, const char *message)
{
    Failure *f = g_new0(Failure, 1);

    f->tv         = term_view_ref(tv);
    f->generation = generation;
    f->message    = g_strdup(message);
    g_idle_add_full(G_PRIORITY_DEFAULT, term_failure_idle, f, failure_free);
}

static bool term_view_spawn(JSContext *ctx, TermView *tv, char **argv,
                            const char *cwd)
{
    if (tv->io && g_atomic_int_get(&tv->io->alive)) {
        JS_ThrowPlainError(ctx, "Run: a child is already running in this "
                                "Terminal");
        return false;
    }
    if (tv->io) {
        winterm_shutdown(tv->io);
        winterm_unref(tv->io);
        tv->io = NULL;
    }

    guint generation = ++tv->generation;
    char *error = NULL;
    WinTerm *wt = winterm_create(tv, argv, cwd, &error);

    if (!wt) {
        term_view_failure(tv, generation,
                          error ? error : "could not start the child");
        g_free(error);
        return true;
    }

    tv->win32_input = false;
    tv->win32_match = 0;
    tv->io = wt;
    if (!winterm_start(wt)) {
        winterm_shutdown(wt);
        winterm_unref(wt);
        tv->io = NULL;
        term_view_failure(tv, generation, "could not start the child's "
                                         "reader or waiter thread");
    } else if (tv->area && gtk_widget_has_focus(tv->area)) {
        winterm_write(wt, "\x1b[I", 3);
    }
    return true;
}

/* ---------------------------------------------------------------- reading */

static void term_append_cell(GString *out, const VTermScreenCell *cell)
{
    char utf8[VTERM_MAX_CHARS_PER_CELL * 4 + 1];

    if (cell->width == 0)
        return;
    if (cell->chars[0] == 0) {
        g_string_append_c(out, ' ');
        return;
    }
    int n = 0;

    for (int i = 0; i < VTERM_MAX_CHARS_PER_CELL && cell->chars[i]; i++)
        n += g_unichar_to_utf8(cell->chars[i], utf8 + n);
    g_string_append_len(out, utf8, n);
}

static void term_append_line(GString *out, const VTermScreenCell *cells,
                             int cols)
{
    gsize start = out->len;

    for (int i = 0; i < cols; i++)
        term_append_cell(out, &cells[i]);
    while (out->len > start) {
        char last = out->str[out->len - 1];

        if (last != ' ' && last != '\t')
            break;
        g_string_truncate(out, out->len - 1);
    }
    g_string_append_c(out, '\n');
}

static char *term_view_read(TermView *tv)
{
    GString *out = g_string_new(NULL);
    int      cols;

    if (!tv)
        return g_string_free(out, FALSE);

    for (GList *l = tv->scrollback->head; l; l = l->next) {
        TermLine *line = l->data;

        term_append_line(out, line->cells, line->cols);
    }

    cols = tv->cols;
    if (cols > 0) {
        VTermScreenCell *cells = g_new0(VTermScreenCell, cols);

        for (int row = 0; row < tv->rows; row++) {
            for (int col = 0; col < cols; col++)
                vterm_screen_get_cell(tv->screen,
                                      (VTermPos){ .row = row, .col = col },
                                      &cells[col]);
            term_append_line(out, cells, cols);
        }
        g_free(cells);
    }
    return g_string_free(out, FALSE);
}

/* ------------------------------------------------------------- the pointer */

static bool term_cell_at(TermView *tv, double x, double y, int *row, int *col)
{
    if (!tv->area || !tv->cell_w || !tv->cell_h)
        return false;

    int w = gtk_widget_get_width(tv->area);
    int h = gtk_widget_get_height(tv->area);

    if (x < 0 || y < 0 || x >= w || y >= h)
        return false;
    *col = (int)(x / tv->cell_w);
    *row = (int)(y / tv->cell_h);
    return *row < tv->rows && *col < tv->cols;
}

static char *term_row_text(TermView *tv, int row, int **offsets, int *cols)
{
    GString *text = g_string_new(NULL);
    int      n    = tv->cols;
    int     *off  = g_new0(int, n + 1);

    for (int col = 0; col < n; col++) {
        VTermScreenCell cell;
        char            utf8[VTERM_MAX_CHARS_PER_CELL * 4 + 1];

        off[col] = (int)text->len;
        if (!vterm_screen_get_cell(tv->screen,
                                   (VTermPos){ .row = row, .col = col },
                                   &cell))
            continue;
        if (cell.width == 0)
            continue;
        if (cell.chars[0] == 0) {
            g_string_append_c(text, ' ');
            continue;
        }
        int used = 0;

        for (int i = 0; i < VTERM_MAX_CHARS_PER_CELL && cell.chars[i]; i++)
            used += g_unichar_to_utf8(cell.chars[i], utf8 + used);
        g_string_append_len(text, utf8, used);
    }
    off[n] = (int)text->len;

    *offsets = off;
    *cols    = n;
    return g_string_free(text, FALSE);
}

static char *term_match_at(TermView *tv, int row, int col)
{
    int      cols;
    int     *off;
    char    *text;
    GMatchInfo *match = NULL;
    char    *found = NULL;

    if (!tv->link || row < 0 || row >= tv->rows || col < 0 || col >= tv->cols)
        return NULL;

    text = term_row_text(tv, row, &off, &cols);
    g_regex_match_full(tv->link, text, -1, 0, 0, &match, NULL);

    while (g_match_info_matches(match)) {
        int start, end;

        if (g_match_info_fetch_pos(match, 0, &start, &end) &&
            end > start) {
            int first = -1, last = -1;

            for (int i = 0; i < cols; i++) {
                if (off[i] <= start && start < off[i + 1]) {
                    first = i;
                    break;
                }
            }
            for (int i = 0; i < cols; i++) {
                if (off[i] < end && end <= off[i + 1]) {
                    last = i + 1;
                    break;
                }
            }
            if (first < 0 && start == off[cols])
                first = cols;
            if (first >= 0 && last > first && col >= first && col < last) {
                found = g_strndup(text + start, (gsize)(end - start));
                break;
            }
        }
        if (!g_match_info_next(match, NULL))
            break;
    }

    g_match_info_free(match);
    g_free(off);
    g_free(text);
    return found;
}

static void term_view_hover(TermView *tv, int row, int col)
{
    char *match = term_match_at(tv, row, col);
    bool  changed;

    changed = (match == NULL) != (tv->hover == NULL) ||
              (match && tv->hover && strcmp(match, tv->hover) != 0);
    if (changed) {
        g_free(tv->hover);
        tv->hover = match;
        if (tv->area)
            gtk_widget_set_cursor_from_name(tv->area,
                                            match ? "pointer" : "text");
    } else {
        g_free(match);
    }
}

static void term_view_clear_selection(TermView *tv)
{
    tv->sel_start_row = tv->sel_end_row = -1;
    tv->sel_start_col = tv->sel_end_col = -1;
}

static bool term_view_selection_rows(TermView *tv, int *first_row,
                                     int *first_col, int *last_row,
                                     int *last_col)
{
    if (tv->sel_start_row < 0 || tv->sel_end_row < 0)
        return false;

    int sr = tv->sel_start_row, sc = tv->sel_start_col;
    int er = tv->sel_end_row,   ec = tv->sel_end_col;

    if (sr > er || (sr == er && sc > ec)) {
        int t;
        t = sr; sr = er; er = t;
        t = sc; sc = ec; ec = t;
    }
    *first_row = sr; *first_col = sc;
    *last_row  = er; *last_col  = ec;
    return true;
}

static void term_view_copy(TermView *tv)
{
    int first_row, first_col, last_row, last_col;

    if (!term_view_selection_rows(tv, &first_row, &first_col,
                                  &last_row, &last_col))
        return;

    GString *out = g_string_new(NULL);

    for (int row = first_row; row <= last_row; row++) {
        int c0 = row == first_row ? first_col : 0;
        int c1 = row == last_row  ? last_col  : tv->cols - 1;
        gsize start = out->len;

        for (int col = c0; col <= c1; col++) {
            VTermScreenCell cell;

            if (vterm_screen_get_cell(tv->screen,
                                      (VTermPos){ .row = row, .col = col },
                                      &cell))
                term_append_cell(out, &cell);
        }
        while (out->len > start) {
            char last = out->str[out->len - 1];

            if (last != ' ' && last != '\t')
                break;
            g_string_truncate(out, out->len - 1);
        }
        if (row != last_row)
            g_string_append_c(out, '\n');
    }

    if (out->len && tv->area) {
        GdkClipboard *clipboard = gtk_widget_get_clipboard(tv->area);

        gdk_clipboard_set_text(clipboard, out->str);
    }
    g_string_free(out, TRUE);
}

static void term_view_send_text(TermView *tv, const char *text)
{
    vterm_keyboard_start_paste(tv->vt);
    for (const char *p = text; *p; p = g_utf8_next_char(p)) {
        gunichar c = g_utf8_get_char(p);

        if (c == '\r')
            continue;
        if (c == '\n')
            vterm_keyboard_key(tv->vt, VTERM_KEY_ENTER, VTERM_MOD_NONE);
        else if (c == '\t')
            vterm_keyboard_key(tv->vt, VTERM_KEY_TAB, VTERM_MOD_NONE);
        else
            vterm_keyboard_unichar(tv->vt, c, VTERM_MOD_NONE);
    }
    vterm_keyboard_end_paste(tv->vt);
    tv->scroll_offset = 0;
    term_view_update_bar(tv);
    term_view_queue_draw(tv);
}

static void term_paste_ready(GObject *source, GAsyncResult *result, gpointer data)
{
    GtkWidget *area = data;
    GError    *error = NULL;
    char      *text  = gdk_clipboard_read_text_finish(GDK_CLIPBOARD(source),
                                                      result, &error);

    if (text) {
        TermView *tv = g_object_get_data(G_OBJECT(area), TERM_VIEW_KEY);

        if (tv && tv->vt)
            term_view_send_text(tv, text);
        g_free(text);
    }
    g_clear_error(&error);
    g_object_unref(area);
}

static void term_view_paste(TermView *tv)
{
    if (!tv->area)
        return;

    GdkClipboard *clipboard = gtk_widget_get_clipboard(tv->area);

    gdk_clipboard_read_text_async(clipboard, NULL, term_paste_ready,
                                  g_object_ref(tv->area));
}

/* -------------------------------------------------------------- the keys */

static VTermModifier term_modifiers(GdkModifierType state)
{
    VTermModifier mod = VTERM_MOD_NONE;

    if (state & GDK_SHIFT_MASK)
        mod |= VTERM_MOD_SHIFT;
    if (state & GDK_CONTROL_MASK)
        mod |= VTERM_MOD_CTRL;
    if (state & GDK_ALT_MASK)
        mod |= VTERM_MOD_ALT;
    return mod;
}

/* The Windows virtual-key code for a GDK keyval, for the win32-input-mode
 * sequence.  Zero means the key has no Windows identity; a character with no
 * key of its own travels as `VK=0`, which is how TerminalInput treats a
 * synthesized character. */
static WORD term_virtual_key(guint keyval, gunichar c, guint keycode,
                             WORD *scan)
{
    WORD vk = 0;

    switch (keyval) {
    case GDK_KEY_Return:      vk = VK_RETURN;  break;
    case GDK_KEY_KP_Enter:    vk = VK_RETURN;  break;
    case GDK_KEY_Tab:
    case GDK_KEY_ISO_Left_Tab: vk = VK_TAB;    break;
    case GDK_KEY_BackSpace:   vk = VK_BACK;    break;
    case GDK_KEY_Escape:      vk = VK_ESCAPE;  break;
    case GDK_KEY_Up:
    case GDK_KEY_KP_Up:       vk = VK_UP;      break;
    case GDK_KEY_Down:
    case GDK_KEY_KP_Down:     vk = VK_DOWN;    break;
    case GDK_KEY_Left:
    case GDK_KEY_KP_Left:     vk = VK_LEFT;    break;
    case GDK_KEY_Right:
    case GDK_KEY_KP_Right:    vk = VK_RIGHT;   break;
    case GDK_KEY_Insert:
    case GDK_KEY_KP_Insert:   vk = VK_INSERT;  break;
    case GDK_KEY_Delete:
    case GDK_KEY_KP_Delete:   vk = VK_DELETE;  break;
    case GDK_KEY_Home:
    case GDK_KEY_KP_Home:     vk = VK_HOME;    break;
    case GDK_KEY_End:
    case GDK_KEY_KP_End:      vk = VK_END;     break;
    case GDK_KEY_Page_Up:
    case GDK_KEY_KP_Page_Up:  vk = VK_PRIOR;   break;
    case GDK_KEY_Page_Down:
    case GDK_KEY_KP_Page_Down: vk = VK_NEXT;   break;
    case GDK_KEY_KP_0:        vk = VK_NUMPAD0; break;
    case GDK_KEY_KP_1:        vk = VK_NUMPAD1; break;
    case GDK_KEY_KP_2:        vk = VK_NUMPAD2; break;
    case GDK_KEY_KP_3:        vk = VK_NUMPAD3; break;
    case GDK_KEY_KP_4:        vk = VK_NUMPAD4; break;
    case GDK_KEY_KP_5:        vk = VK_NUMPAD5; break;
    case GDK_KEY_KP_6:        vk = VK_NUMPAD6; break;
    case GDK_KEY_KP_7:        vk = VK_NUMPAD7; break;
    case GDK_KEY_KP_8:        vk = VK_NUMPAD8; break;
    case GDK_KEY_KP_9:        vk = VK_NUMPAD9; break;
    case GDK_KEY_KP_Multiply: vk = VK_MULTIPLY; break;
    case GDK_KEY_KP_Add:      vk = VK_ADD;     break;
    case GDK_KEY_KP_Separator: vk = VK_SEPARATOR; break;
    case GDK_KEY_KP_Subtract: vk = VK_SUBTRACT; break;
    case GDK_KEY_KP_Decimal:  vk = VK_DECIMAL; break;
    case GDK_KEY_KP_Divide:   vk = VK_DIVIDE;  break;
    case GDK_KEY_KP_Equal:    vk = VK_OEM_NEC_EQUAL; break;
    default:
        if (keyval >= GDK_KEY_F1 && keyval <= GDK_KEY_F12)
            vk = (WORD)(VK_F1 + (keyval - GDK_KEY_F1));
        break;
    }

    if (vk == 0 && c > 0 && c < 0x80) {
        SHORT scanned = VkKeyScanW((WCHAR)c);

        if (scanned != -1)
            vk = LOBYTE(scanned);
    }

    *scan = keycode > 0 && keycode <= 0xFF
                ? (WORD)keycode
                : (vk ? (WORD)MapVirtualKeyW(vk, MAPVK_VK_TO_VSC) : 0);
    return vk;
}

static guint term_ctrl_char(guint c)
{
    if (c >= '@' && c <= '~')
        return c & 0x1F;
    if (c == ' ')
        return 0;
    if (c == '/')
        return 0x1F;
    if (c == '?')
        return 0x7F;
    if (c >= '2' && c <= '8') {
        static const guint numeric[] = { 0, 27, 28, 29, 30, 31, 127 };

        return numeric[c - '2'];
    }
    return c;
}

static bool term_send_win32_key(TermView *tv, guint keyval, guint keycode,
                                GdkModifierType state)
{
    gunichar c = gdk_keyval_to_unicode(keyval);
    bool     ctrl  = (state & GDK_CONTROL_MASK) != 0;
    bool     alt   = (state & GDK_ALT_MASK) != 0;
    bool     shift = (state & GDK_SHIFT_MASK) != 0;
    bool     altgr = ctrl && alt && c > 0x20 && c != 0x7F;
    WORD     scan = 0;
    WORD     vk   = term_virtual_key(keyval, c, keycode, &scan);
    WORD     uc   = 0;
    WORD     cs   = 0;

    if (c > 0xFFFF)
        return false;

    if (altgr) {
        uc = (WORD)c;
        cs = shift ? SHIFT_PRESSED : 0;
    } else if (ctrl) {
        if (c)
            uc = (WORD)term_ctrl_char(c);
        cs = LEFT_CTRL_PRESSED | (shift ? SHIFT_PRESSED : 0);
        /* A punctuation key's VkKeyScanW answer carries a shift state that
         * would turn Ctrl+@ into Ctrl+2; the character alone is the event. */
        if (c && !(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z'))
            vk = 0;
    } else if (alt) {
        cs = LEFT_ALT_PRESSED | (shift ? SHIFT_PRESSED : 0);
    } else {
        uc = (WORD)(c <= 0xFFFF ? c : 0);
        cs = shift ? SHIFT_PRESSED : 0;
    }

    switch (keyval) {
    case GDK_KEY_Return:       uc = 13; break;
    case GDK_KEY_KP_Enter:     uc = 13; cs |= ENHANCED_KEY; break;
    case GDK_KEY_Tab:          uc = 9;  break;
    case GDK_KEY_ISO_Left_Tab: uc = 9;  cs |= SHIFT_PRESSED; break;
    case GDK_KEY_BackSpace:    uc = 8;  break;
    case GDK_KEY_Escape:       uc = 27; break;
    /* The non-keypad navigation keys are "enhanced" in a Windows console;
     * their keypad twins are not, which is what lets ConPTY tell them apart. */
    case GDK_KEY_Up:
    case GDK_KEY_Down:
    case GDK_KEY_Left:
    case GDK_KEY_Right:
    case GDK_KEY_Insert:
    case GDK_KEY_Delete:
    case GDK_KEY_Home:
    case GDK_KEY_End:
    case GDK_KEY_Page_Up:
    case GDK_KEY_Page_Down:
        cs |= ENHANCED_KEY;
        break;
    default:
        break;
    }

    if (vk == 0 && uc == 0)
        return false;

    char     seq[80];
    int      n = g_snprintf(seq, sizeof(seq), "\x1b[%u;%u;%u;1;%u;1_",
                            (unsigned)vk, (unsigned)scan, (unsigned)uc,
                            (unsigned)cs);

    winterm_write(tv->io, seq, (size_t)n);
    return true;
}

static void term_send_ctrl_c(TermView *tv)
{
    if (!tv->io)
        return;

    if (tv->win32_input)
        winterm_write(tv->io, "\x1b[67;46;3;1;8;1_", 16);
    else
        winterm_write(tv->io, "\x03", 1);
}

static void term_send_unichar(TermView *tv, gunichar c, VTermModifier mod)
{
    /* AltGr arrives as Ctrl+Alt on Windows and carries an ordinary character;
     * treating it as a control chord is how a Spanish keyboard loses its @. */
    if ((mod & (VTERM_MOD_CTRL | VTERM_MOD_ALT)) ==
            (VTERM_MOD_CTRL | VTERM_MOD_ALT) && c >= 0x20) {
        vterm_keyboard_unichar(tv->vt, c, VTERM_MOD_NONE);
        return;
    }

    if ((mod & VTERM_MOD_CTRL) && c < 0x80) {
        if (c >= 'a' && c <= 'z')
            c = c - 'a' + 1;
        else if (c >= 'A' && c <= 'Z')
            c = c - 'A' + 1;
        else if (c == ' ' || c == '@')
            c = 0;
        else if (c == '[')
            c = 27;
        else if (c == '\\')
            c = 28;
        else if (c == ']')
            c = 29;
        else if (c == '^')
            c = 30;
        else if (c == '_')
            c = 31;
        else if (c == '?')
            c = 127;
        mod &= ~VTERM_MOD_CTRL;
    }

    /* The keyval already has Shift applied; saying it again would make
     * libvterm look for a shifted form of the character it was given. */
    mod &= ~VTERM_MOD_SHIFT;
    vterm_keyboard_unichar(tv->vt, c, mod);
}

static void term_view_scroll(TermView *tv, int lines, bool absolute)
{
    int sb = (int)g_queue_get_length(tv->scrollback);

    if (absolute)
        tv->scroll_offset = lines;
    else
        tv->scroll_offset += lines;
    tv->scroll_offset = CLAMP(tv->scroll_offset, 0, sb);
    term_view_update_bar(tv);
    term_view_queue_draw(tv);
}

static gboolean term_key_pressed(GtkEventControllerKey *controller,
                                 guint keyval, guint keycode,
                                 GdkModifierType state, gpointer data)
{
    TermView *tv = data;
    bool      ctrl  = (state & GDK_CONTROL_MASK) != 0;
    bool      shift = (state & GDK_SHIFT_MASK) != 0;

    (void)keycode;

    GdkEvent *event = gtk_event_controller_get_current_event(
        GTK_EVENT_CONTROLLER(controller));

    if (tv->im && event && gtk_im_context_filter_keypress(tv->im, event))
        return TRUE;

    if (ctrl && shift && (keyval == GDK_KEY_c || keyval == GDK_KEY_C)) {
        term_view_copy(tv);
        return TRUE;
    }
    if ((ctrl && (keyval == GDK_KEY_v || keyval == GDK_KEY_V)) ||
        (shift && keyval == GDK_KEY_Insert)) {
        term_view_paste(tv);
        return TRUE;
    }

    if (shift && (keyval == GDK_KEY_Page_Up || keyval == GDK_KEY_KP_Page_Up)) {
        term_view_scroll(tv, MAX(1, tv->rows - 2), false);
        return TRUE;
    }
    if (shift && (keyval == GDK_KEY_Page_Down ||
                  keyval == GDK_KEY_KP_Page_Down)) {
        term_view_scroll(tv, -MAX(1, tv->rows - 2), false);
        return TRUE;
    }
    if (shift && (keyval == GDK_KEY_Home || keyval == GDK_KEY_KP_Home)) {
        term_view_scroll(tv, (int)g_queue_get_length(tv->scrollback), true);
        return TRUE;
    }
    if (shift && (keyval == GDK_KEY_End || keyval == GDK_KEY_KP_End)) {
        term_view_scroll(tv, 0, true);
        return TRUE;
    }

    /* ConPTY's input side is a console, not a Unix line discipline: Ctrl+C
     * has to arrive as a key event, not as the byte 0x03.  Libvterm still
     * encodes the fallback for a host that never announced win32-input-mode. */
    if (tv->win32_input &&
        term_send_win32_key(tv, keyval, keycode, state)) {
        term_view_clear_selection(tv);
        tv->scroll_offset = 0;
        term_view_update_bar(tv);
        term_view_queue_draw(tv);
        return TRUE;
    }

    VTermModifier mod = term_modifiers(state);
    VTermKey      key = VTERM_KEY_NONE;

    switch (keyval) {
    case GDK_KEY_Return:
    case GDK_KEY_KP_Enter:    key = VTERM_KEY_ENTER;    break;
    case GDK_KEY_Tab:         key = VTERM_KEY_TAB;      break;
    case GDK_KEY_ISO_Left_Tab: key = VTERM_KEY_TAB;     break;
    case GDK_KEY_BackSpace:   key = VTERM_KEY_BACKSPACE; break;
    case GDK_KEY_Escape:      key = VTERM_KEY_ESCAPE;   break;
    case GDK_KEY_Up:
    case GDK_KEY_KP_Up:       key = VTERM_KEY_UP;       break;
    case GDK_KEY_Down:
    case GDK_KEY_KP_Down:     key = VTERM_KEY_DOWN;     break;
    case GDK_KEY_Left:
    case GDK_KEY_KP_Left:     key = VTERM_KEY_LEFT;     break;
    case GDK_KEY_Right:
    case GDK_KEY_KP_Right:    key = VTERM_KEY_RIGHT;    break;
    case GDK_KEY_Insert:
    case GDK_KEY_KP_Insert:   key = VTERM_KEY_INS;      break;
    case GDK_KEY_Delete:
    case GDK_KEY_KP_Delete:   key = VTERM_KEY_DEL;      break;
    case GDK_KEY_Home:
    case GDK_KEY_KP_Home:     key = VTERM_KEY_HOME;     break;
    case GDK_KEY_End:
    case GDK_KEY_KP_End:      key = VTERM_KEY_END;      break;
    case GDK_KEY_Page_Up:
    case GDK_KEY_KP_Page_Up:  key = VTERM_KEY_PAGEUP;   break;
    case GDK_KEY_Page_Down:
    case GDK_KEY_KP_Page_Down: key = VTERM_KEY_PAGEDOWN; break;
    case GDK_KEY_KP_0:        key = VTERM_KEY_KP_0;      break;
    case GDK_KEY_KP_1:        key = VTERM_KEY_KP_1;      break;
    case GDK_KEY_KP_2:        key = VTERM_KEY_KP_2;      break;
    case GDK_KEY_KP_3:        key = VTERM_KEY_KP_3;      break;
    case GDK_KEY_KP_4:        key = VTERM_KEY_KP_4;      break;
    case GDK_KEY_KP_5:        key = VTERM_KEY_KP_5;      break;
    case GDK_KEY_KP_6:        key = VTERM_KEY_KP_6;      break;
    case GDK_KEY_KP_7:        key = VTERM_KEY_KP_7;      break;
    case GDK_KEY_KP_8:        key = VTERM_KEY_KP_8;      break;
    case GDK_KEY_KP_9:        key = VTERM_KEY_KP_9;      break;
    case GDK_KEY_KP_Multiply: key = VTERM_KEY_KP_MULT;   break;
    case GDK_KEY_KP_Add:      key = VTERM_KEY_KP_PLUS;   break;
    case GDK_KEY_KP_Separator: key = VTERM_KEY_KP_COMMA; break;
    case GDK_KEY_KP_Subtract: key = VTERM_KEY_KP_MINUS;  break;
    case GDK_KEY_KP_Decimal:  key = VTERM_KEY_KP_PERIOD; break;
    case GDK_KEY_KP_Divide:   key = VTERM_KEY_KP_DIVIDE; break;
    case GDK_KEY_KP_Equal:    key = VTERM_KEY_KP_EQUAL;  break;
    default:
        if (keyval >= GDK_KEY_F1 && keyval <= GDK_KEY_F12)
            key = VTERM_KEY_FUNCTION(keyval - GDK_KEY_F1 + 1);
        break;
    }

    if (key == VTERM_KEY_NONE) {
        gunichar c = gdk_keyval_to_unicode(keyval);

        if (c == 0)
            return FALSE;
        term_view_clear_selection(tv);
        tv->scroll_offset = 0;
        term_view_update_bar(tv);
        term_send_unichar(tv, c, mod);
        term_view_queue_draw(tv);
        return TRUE;
    }

    if (keyval == GDK_KEY_ISO_Left_Tab)
        mod |= VTERM_MOD_SHIFT;
    term_view_clear_selection(tv);
    tv->scroll_offset = 0;
    term_view_update_bar(tv);
    vterm_keyboard_key(tv->vt, key, mod);
    term_view_queue_draw(tv);
    return TRUE;
}

static void term_im_commit(GtkIMContext *im, const char *text, gpointer data)
{
    TermView *tv = data;

    (void)im;
    for (const char *p = text; *p; p = g_utf8_next_char(p)) {
        gunichar c = g_utf8_get_char(p);

        if (c == '\r')
            continue;
        if (c == '\n')
            vterm_keyboard_key(tv->vt, VTERM_KEY_ENTER, VTERM_MOD_NONE);
        else
            vterm_keyboard_unichar(tv->vt, c, VTERM_MOD_NONE);
    }
    tv->scroll_offset = 0;
    term_view_update_bar(tv);
    term_view_queue_draw(tv);
}

static void term_focus_enter(GtkEventControllerFocus *controller, gpointer data)
{
    TermView *tv = data;

    (void)controller;
    tv->focused = true;
    if (tv->im)
        gtk_im_context_focus_in(tv->im);
    /* ConPTY asks for `CSI ? 1004 h` in its opening output and uses the
     * answer to know whether the console has the focus. */
    winterm_write(tv->io, "\x1b[I", 3);
    term_view_queue_draw(tv);
}

static void term_focus_leave(GtkEventControllerFocus *controller, gpointer data)
{
    TermView *tv = data;

    (void)controller;
    tv->focused = false;
    if (tv->im)
        gtk_im_context_focus_out(tv->im);
    winterm_write(tv->io, "\x1b[O", 3);
    term_view_queue_draw(tv);
}

/* -------------------------------------------------------------- the mouse */

static void term_emit_link(TermView *tv)
{
    BtaWidget *w = term_view_widget(tv);

    if (!w || !tv->hover)
        return;

    JSValue arg = JS_NewString(w->ctx, tv->hover);

    bta_emit(w, "Link", 1, &arg);
    JS_FreeValue(w->ctx, arg);
}

static void term_click_pressed(GtkGestureClick *gesture, int n_press,
                               double x, double y, gpointer data)
{
    TermView *tv = data;
    int row, col;
    GdkModifierType state = gtk_event_controller_get_current_event_state(
        GTK_EVENT_CONTROLLER(gesture));
    guint button = gtk_gesture_single_get_current_button(
        GTK_GESTURE_SINGLE(gesture));

    (void)n_press;
    if (!term_cell_at(tv, x, y, &row, &col))
        return;

    if (tv->area)
        gtk_widget_grab_focus(tv->area);

    tv->scroll_offset = 0;
    term_view_update_bar(tv);
    tv->pointer_row = row;
    tv->pointer_col = col;

    if (tv->mouse_mode != VTERM_PROP_MOUSE_NONE &&
        !(state & GDK_SHIFT_MASK)) {
        vterm_mouse_move(tv->vt, row, col, term_modifiers(state));
        vterm_mouse_button(tv->vt, (int)button, true, term_modifiers(state));
        tv->mouse_down = (int)button;
        return;
    }

    if (button == 1) {
        term_view_clear_selection(tv);
        tv->selecting    = true;
        tv->press_moved  = false;
        tv->sel_start_row = row;
        tv->sel_start_col = col;
        tv->sel_end_row   = row;
        tv->sel_end_col   = col;
        g_free(tv->pressed_link);
        tv->pressed_link = g_strdup(tv->hover);
        term_view_queue_draw(tv);
    } else if (button == 2 || button == 3) {
        term_view_paste(tv);
    }
}

static void term_click_released(GtkGestureClick *gesture, int n_press,
                                double x, double y, gpointer data)
{
    TermView *tv = data;
    GdkModifierType state = gtk_event_controller_get_current_event_state(
        GTK_EVENT_CONTROLLER(gesture));
    guint button = gtk_gesture_single_get_current_button(
        GTK_GESTURE_SINGLE(gesture));

    (void)n_press;

    if (tv->mouse_down && tv->mouse_mode != VTERM_PROP_MOUSE_NONE) {
        vterm_mouse_button(tv->vt, tv->mouse_down, false,
                           term_modifiers(state));
        tv->mouse_down = 0;
        return;
    }

    if (button != 1 || !tv->selecting)
        return;

    int row, col;

    if (term_cell_at(tv, x, y, &row, &col))
        term_view_hover(tv, row, col);

    tv->selecting = false;
    if (!tv->press_moved && tv->pressed_link && tv->hover &&
        strcmp(tv->pressed_link, tv->hover) == 0) {
        term_emit_link(tv);
        term_view_clear_selection(tv);
        term_view_queue_draw(tv);
    }
    g_clear_pointer(&tv->pressed_link, g_free);
}

static void term_motion(GtkEventControllerMotion *controller, double x,
                        double y, gpointer data)
{
    TermView *tv = data;
    int row, col;

    if (!term_cell_at(tv, x, y, &row, &col)) {
        if (tv->hover) {
            g_free(tv->hover);
            tv->hover = NULL;
            if (tv->area)
                gtk_widget_set_cursor_from_name(tv->area, "text");
        }
        return;
    }

    tv->pointer_row = row;
    tv->pointer_col = col;

    GdkModifierType state = gtk_event_controller_get_current_event_state(
        GTK_EVENT_CONTROLLER(controller));

    if (tv->selecting) {
        if (state & GDK_BUTTON1_MASK) {
            if (row != tv->sel_end_row || col != tv->sel_end_col) {
                tv->press_moved = true;
                tv->sel_end_row = row;
                tv->sel_end_col = col;
                term_view_queue_draw(tv);
            }
        }
        return;
    }

    if (tv->mouse_mode >= VTERM_PROP_MOUSE_DRAG &&
        (state & GDK_BUTTON1_MASK)) {
        vterm_mouse_move(tv->vt, row, col, term_modifiers(state));
        return;
    }
    if (tv->mouse_mode == VTERM_PROP_MOUSE_MOVE) {
        vterm_mouse_move(tv->vt, row, col, term_modifiers(state));
        return;
    }

    term_view_hover(tv, row, col);
}

static void term_motion_leave(GtkEventControllerMotion *controller,
                              gpointer data)
{
    TermView *tv = data;

    (void)controller;
    g_clear_pointer(&tv->hover, g_free);
    if (tv->area)
        gtk_widget_set_cursor_from_name(tv->area, "text");
}

static gboolean term_scroll(GtkEventControllerScroll *controller, double dx,
                            double dy, gpointer data)
{
    TermView *tv = data;
    GdkModifierType state = gtk_event_controller_get_current_event_state(
        GTK_EVENT_CONTROLLER(controller));

    (void)dx;
    if (dy == 0)
        return FALSE;

    if (tv->mouse_mode != VTERM_PROP_MOUSE_NONE &&
        !(state & GDK_SHIFT_MASK)) {
        guint button = dy < 0 ? 4 : 5;

        vterm_mouse_move(tv->vt, tv->pointer_row, tv->pointer_col,
                         term_modifiers(state));
        vterm_mouse_button(tv->vt, (int)button, true, term_modifiers(state));
        vterm_mouse_button(tv->vt, (int)button, false, term_modifiers(state));
        return TRUE;
    }

    term_view_scroll(tv, dy < 0 ? 3 : -3, false);
    return TRUE;
}

/* -------------------------------------------------------------- the paint */

static void term_draw_line(TermView *tv, cairo_t *cr,
                           const VTermScreenCell *cells, int cols, int row,
                           int y, bool selected)
{
    int first_row, first_col, last_row, last_col;
    bool has_selection = selected &&
        term_view_selection_rows(tv, &first_row, &first_col,
                                 &last_row, &last_col);

    for (int col = 0; col < tv->cols; col++) {
        VTermScreenCell cell;

        if (col < cols) {
            cell = cells[col];
        } else {
            ZeroMemory(&cell, sizeof(cell));
            cell.fg.type = VTERM_COLOR_DEFAULT_FG;
            cell.bg.type = VTERM_COLOR_DEFAULT_BG;
            cell.width = 1;
        }
        if (cell.width == 0)
            continue;                    /* the right half of a wide glyph */

        int cell_width = cell.width > 0 ? cell.width : 1;
        bool is_selected = has_selection && row >= first_row && row <= last_row;
        if (is_selected && row == first_row && col < first_col)
            is_selected = false;
        if (is_selected && row == last_row && col > last_col)
            is_selected = false;

        TermRgb fg = term_color(cell.fg, true, cell.attrs.bold);
        TermRgb bg = term_color(cell.bg, false, false);

        if (cell.attrs.reverse) {
            TermRgb swap = fg;
            fg = bg;
            bg = swap;
        }
        if (is_selected)
            bg = TERM_SELECTION;

        if (bg.r != TERM_BG.r || bg.g != TERM_BG.g || bg.b != TERM_BG.b) {
            term_set_color(cr, bg);
            cairo_rectangle(cr, col * tv->cell_w, y,
                            cell_width * tv->cell_w, tv->cell_h);
            cairo_fill(cr);
        }

        if (cell.attrs.conceal || cell.chars[0] == 0)
            continue;

        char utf8[VTERM_MAX_CHARS_PER_CELL * 4 + 1];
        int  len = 0;

        for (int i = 0; i < VTERM_MAX_CHARS_PER_CELL && cell.chars[i]; i++)
            len += g_unichar_to_utf8(cell.chars[i], utf8 + len);

        PangoFontDescription *font = tv->font;
        if (cell.attrs.bold && cell.attrs.italic)
            font = tv->font_bold_italic;
        else if (cell.attrs.bold)
            font = tv->font_bold;
        else if (cell.attrs.italic)
            font = tv->font_italic;

        pango_layout_set_font_description(tv->layout, font);
        pango_layout_set_text(tv->layout, utf8, len);

        term_set_color(cr, fg);
        cairo_move_to(cr, col * tv->cell_w, y);
        pango_cairo_show_layout(cr, tv->layout);

        if (cell.attrs.underline) {
            cairo_set_line_width(cr, 1.0);
            cairo_move_to(cr, col * tv->cell_w,
                          y + tv->cell_h - 1.5);
            cairo_line_to(cr, (col + cell_width) * tv->cell_w,
                          y + tv->cell_h - 1.5);
            cairo_stroke(cr);
        }
        if (cell.attrs.strike) {
            cairo_set_line_width(cr, 1.0);
            cairo_move_to(cr, col * tv->cell_w, y + tv->cell_h / 2.0);
            cairo_line_to(cr, (col + cell_width) * tv->cell_w,
                          y + tv->cell_h / 2.0);
            cairo_stroke(cr);
        }
    }
}

static void term_draw_cursor(TermView *tv, cairo_t *cr)
{
    VTermPos cursor;
    VTermScreenCell cell;
    int shape;

    if (tv->scroll_offset != 0 || !tv->cursor_visible)
        return;

    vterm_state_get_cursorpos(tv->state, &cursor);
    if (cursor.row < 0 || cursor.row >= tv->rows ||
        cursor.col < 0 || cursor.col >= tv->cols)
        return;

    vterm_screen_get_cell(tv->screen, cursor, &cell);
    shape = tv->cursor_shape ? tv->cursor_shape
                             : VTERM_PROP_CURSORSHAPE_BLOCK;

    int x = cursor.col * tv->cell_w;
    int y = cursor.row * tv->cell_h;

    if (!tv->focused) {
        term_set_color(cr, TERM_FG);
        cairo_set_line_width(cr, 1.0);
        cairo_rectangle(cr, x + 0.5, y + 0.5,
                        tv->cell_w - 1.0, tv->cell_h - 1.0);
        cairo_stroke(cr);
        return;
    }

    if (shape == VTERM_PROP_CURSORSHAPE_UNDERLINE) {
        term_set_color(cr, TERM_FG);
        cairo_rectangle(cr, x, y + tv->cell_h - 2, tv->cell_w, 2);
        cairo_fill(cr);
        return;
    }
    if (shape == VTERM_PROP_CURSORSHAPE_BAR_LEFT) {
        term_set_color(cr, TERM_FG);
        cairo_rectangle(cr, x, y, 2, tv->cell_h);
        cairo_fill(cr);
        return;
    }

    term_set_color(cr, TERM_FG);
    cairo_rectangle(cr, x, y, tv->cell_w, tv->cell_h);
    cairo_fill(cr);

    if (cell.chars[0]) {
        char utf8[VTERM_MAX_CHARS_PER_CELL * 4 + 1];
        int  len = 0;

        for (int i = 0; i < VTERM_MAX_CHARS_PER_CELL && cell.chars[i]; i++)
            len += g_unichar_to_utf8(cell.chars[i], utf8 + len);
        pango_layout_set_font_description(tv->layout, tv->font);
        pango_layout_set_text(tv->layout, utf8, len);
        term_set_color(cr, TERM_BG);
        cairo_move_to(cr, x, y);
        pango_cairo_show_layout(cr, tv->layout);
    }
}

static void term_sync_size(TermView *tv, int width, int height)
{
    int cols = MAX(1, width / MAX(1, tv->cell_w));
    int rows = MAX(1, height / MAX(1, tv->cell_h));

    if (cols == tv->cols && rows == tv->rows)
        return;

    /* libvterm itself hands the rows a shrink cuts off to `sb_pushline`, so
     * the history is complete without this file copying them again.  Measured
     * with a 24-row screen and forty lines: seventeen pushes while feeding,
     * nineteen more at `vterm_set_size(5, 80)`, and rows 37-40 left on
     * screen. */
    tv->cols = cols;
    tv->rows = rows;
    vterm_set_size(tv->vt, rows, cols);
    if (tv->io && g_atomic_int_get(&tv->io->alive)) {
        COORD size = { (SHORT)CLAMP(cols, 1, 32767),
                       (SHORT)CLAMP(rows, 1, 32767) };

        ResizePseudoConsole(tv->io->hpc, size);
    }
    term_view_update_bar(tv);
}

static void term_area_draw(GtkDrawingArea *area, cairo_t *cr, int width,
                           int height, gpointer data)
{
    TermView *tv = data;

    (void)area;
    if (!tv->area)
        return;

    if (!tv->layout)
        term_metrics(tv);

    term_sync_size(tv, width, height);
    if (tv->cols > tv->scratch_cols) {
        tv->scratch = g_renew(VTermScreenCell, tv->scratch, tv->cols);
        tv->scratch_cols = tv->cols;
    }

    term_set_color(cr, TERM_BG);
    cairo_paint(cr);

    int sb = (int)g_queue_get_length(tv->scrollback);
    int top = sb - tv->scroll_offset;

    for (int y = 0; y < tv->rows; y++) {
        int line = top + y;

        if (line < 0)
            continue;
        if (line < sb) {
            TermLine *ln = g_queue_peek_nth(tv->scrollback, (guint)line);

            if (ln)
                term_draw_line(tv, cr, ln->cells, ln->cols, -1,
                               y * tv->cell_h, false);
        } else {
            int row = line - sb;

            if (row < 0 || row >= tv->rows)
                continue;
            for (int col = 0; col < tv->cols; col++)
                vterm_screen_get_cell(tv->screen,
                                      (VTermPos){ .row = row, .col = col },
                                      &tv->scratch[col]);
            term_draw_line(tv, cr, tv->scratch, tv->cols, row,
                           y * tv->cell_h, tv->scroll_offset == 0);
        }
    }

    term_draw_cursor(tv, cr);
}

/* ------------------------------------------------------------- lifecycle */

static void term_view_detach(TermView *tv)
{
    if (!tv->area)
        return;

    tv->area  = NULL;
    tv->outer = NULL;
    tv->bar   = NULL;
    tv->adj   = NULL;

    if (tv->io) {
        winterm_shutdown(tv->io);
        winterm_unref(tv->io);
        tv->io = NULL;
    }
}

static void term_view_free(TermView *tv)
{
    if (tv->io) {
        winterm_shutdown(tv->io);
        winterm_unref(tv->io);
    }
    if (tv->scrollback)
        g_queue_free_full(tv->scrollback, term_line_free);
    if (tv->vt)
        vterm_free(tv->vt);
    g_clear_object(&tv->layout);
    g_clear_pointer(&tv->font, pango_font_description_free);
    g_clear_pointer(&tv->font_bold, pango_font_description_free);
    g_clear_pointer(&tv->font_italic, pango_font_description_free);
    g_clear_pointer(&tv->font_bold_italic, pango_font_description_free);
    g_clear_pointer(&tv->link, g_regex_unref);
    g_clear_object(&tv->im);
    g_free(tv->hover);
    g_free(tv->pressed_link);
    g_free(tv->scratch);
    g_free(tv);
}

static void term_view_unref(TermView *tv)
{
    if (g_atomic_int_dec_and_test(&tv->refs))
        term_view_free(tv);
}

static void term_view_owned_free(gpointer data)
{
    TermView *tv = data;

    term_view_detach(tv);
    term_view_unref(tv);
}

/*
 * **The input method is the area's only while the area has a window.**
 * GTK's Windows IME context registers a message filter on the display in
 * `focus_in`, with itself as the filter's data, and removes it only in
 * `focus_out` -- which returns early, filter still in place, once the client
 * widget has no surface. Neither its dispose nor the multicontext's teardown
 * calls `focus_out` (read in GTK 4.24.1). A Terminal deleted while it held
 * the focus therefore left a filter pointing at a freed context, and the next
 * window message ran it: `gtk_im_context_ime_message_filter: assertion
 * 'GTK_IS_IM_CONTEXT_IME (data)' failed` and an access violation from
 * `SendMessageW`, at the end of `tests/widgets`. The multicontext also keeps a
 * `notify::gtk-im-module` handler on the client's settings until it is told
 * the client is gone. So the client is set on realize and taken away on
 * unrealize, focus first, while the surface is still there -- what GtkText
 * does. The handler runs before the class's own unrealize.
 */
static void term_area_realize(GtkWidget *widget, gpointer data)
{
    TermView *tv = data;

    if (tv->im)
        gtk_im_context_set_client_widget(tv->im, widget);
}

static void term_area_unrealize(GtkWidget *widget, gpointer data)
{
    TermView *tv = data;

    (void)widget;
    if (tv->im) {
        gtk_im_context_focus_out(tv->im);
        gtk_im_context_set_client_widget(tv->im, NULL);
    }
}

static void term_area_destroy(GtkWidget *widget, gpointer data)
{
    TermView *tv = data;

    (void)widget;
    if (tv->im)
        gtk_im_context_set_client_widget(tv->im, NULL);
    term_view_detach(tv);
}

static void term_bar_changed(GtkAdjustment *adj, gpointer data)
{
    TermView *tv = data;
    int sb, rows, value, offset;

    if (tv->updating_bar || !tv->area)
        return;

    sb    = (int)g_queue_get_length(tv->scrollback);
    rows  = MAX(1, tv->rows);
    value = (int)gtk_adjustment_get_value(adj);
    offset = sb - value;
    offset = CLAMP(offset, 0, sb);
    if (offset != tv->scroll_offset) {
        tv->scroll_offset = offset;
        term_view_queue_draw(tv);
    }
    (void)rows;
}

static TermView *term_view_new(GtkWidget *area)
{
    TermView *tv = g_new0(TermView, 1);

    tv->refs            = 1;
    tv->area            = area;
    tv->font_scale      = 1.0;
    tv->scrollback_lines = 10000;
    tv->scrollback      = g_queue_new();
    tv->rows            = 24;
    tv->cols            = 80;
    tv->cursor_visible  = true;
    tv->cursor_shape    = VTERM_PROP_CURSORSHAPE_BLOCK;

    tv->vt = vterm_new(tv->rows, tv->cols);
    vterm_set_utf8(tv->vt, 1);
    tv->screen = vterm_obtain_screen(tv->vt);
    tv->state  = vterm_obtain_state(tv->vt);

    VTermColor fg, bg;

    vterm_color_rgb(&fg, TERM_FG.r, TERM_FG.g, TERM_FG.b);
    vterm_color_rgb(&bg, TERM_BG.r, TERM_BG.g, TERM_BG.b);
    vterm_screen_set_default_colors(tv->screen, &fg, &bg);
    vterm_screen_set_callbacks(tv->screen, &term_screen_callbacks, tv);
    vterm_screen_set_damage_merge(tv->screen, VTERM_DAMAGE_ROW);
    vterm_screen_enable_altscreen(tv->screen, 1);
    vterm_screen_reset(tv->screen, 1);
    vterm_output_set_callback(tv->vt, term_output_cb, tv);

    term_metrics(tv);
    return tv;
}

/* ------------------------------------------------------------ public half */

void bta_terminal_win32_build(BtaWidget *w)
{
    GtkWidget *area = gtk_drawing_area_new();
    GtkWidget *box  = g_object_new(bta_term_box_get_type(), NULL);

    gtk_widget_set_focusable(area, TRUE);
    gtk_widget_set_hexpand(area, TRUE);
    gtk_widget_set_vexpand(area, TRUE);
    gtk_widget_set_cursor_from_name(area, "text");

    TermView *tv = term_view_new(area);

    g_object_set_data_full(G_OBJECT(area), TERM_VIEW_KEY, tv,
                           term_view_owned_free);
    g_signal_connect(area, "destroy", G_CALLBACK(term_area_destroy), tv);
    gtk_drawing_area_set_draw_func(GTK_DRAWING_AREA(area), term_area_draw,
                                   tv, NULL);

    tv->outer = box;
    tv->adj = gtk_adjustment_new(0, 0, 1, 1, 1, 1);
    tv->bar = gtk_scrollbar_new(GTK_ORIENTATION_VERTICAL, tv->adj);
    gtk_widget_set_vexpand(tv->bar, TRUE);
    g_signal_connect(tv->adj, "value-changed",
                     G_CALLBACK(term_bar_changed), tv);

    gtk_box_append(GTK_BOX(box), area);
    gtk_box_append(GTK_BOX(box), tv->bar);

    GtkEventController *keys = gtk_event_controller_key_new();

    g_signal_connect(keys, "key-pressed", G_CALLBACK(term_key_pressed), tv);
    gtk_widget_add_controller(area, keys);

    GtkEventController *focus = gtk_event_controller_focus_new();

    g_signal_connect(focus, "enter", G_CALLBACK(term_focus_enter), tv);
    g_signal_connect(focus, "leave", G_CALLBACK(term_focus_leave), tv);
    gtk_widget_add_controller(area, focus);

    GtkEventController *motion = gtk_event_controller_motion_new();

    g_signal_connect(motion, "motion", G_CALLBACK(term_motion), tv);
    g_signal_connect(motion, "leave", G_CALLBACK(term_motion_leave), tv);
    gtk_widget_add_controller(area, motion);

    GtkGesture *click = gtk_gesture_click_new();

    gtk_gesture_single_set_button(GTK_GESTURE_SINGLE(click), 0);
    g_signal_connect(click, "pressed", G_CALLBACK(term_click_pressed), tv);
    g_signal_connect(click, "released", G_CALLBACK(term_click_released), tv);
    gtk_widget_add_controller(area, GTK_EVENT_CONTROLLER(click));

    GtkEventController *scroll = gtk_event_controller_scroll_new(
        GTK_EVENT_CONTROLLER_SCROLL_VERTICAL);

    g_signal_connect(scroll, "scroll", G_CALLBACK(term_scroll), tv);
    gtk_widget_add_controller(area, scroll);

    tv->im = gtk_im_multicontext_new();
    gtk_im_context_set_use_preedit(tv->im, TRUE);
    g_signal_connect(tv->im, "commit", G_CALLBACK(term_im_commit), tv);
    g_signal_connect(area, "realize", G_CALLBACK(term_area_realize), tv);
    g_signal_connect(area, "unrealize", G_CALLBACK(term_area_unrealize), tv);

    w->inner = area;
    w->gtk   = box;
}

bool bta_terminal_win32_spawn(JSContext *ctx, BtaWidget *w, char **argv,
                              const char *cwd)
{
    TermView *tv = w->inner
                       ? g_object_get_data(G_OBJECT(w->inner), TERM_VIEW_KEY)
                       : NULL;

    if (!tv) {
        JS_ThrowPlainError(ctx, "Run: the Terminal has no backend");
        return false;
    }
    return term_view_spawn(ctx, tv, argv, cwd);
}

bool bta_terminal_win32_alive(BtaWidget *w)
{
    TermView *tv = w->inner
                       ? g_object_get_data(G_OBJECT(w->inner), TERM_VIEW_KEY)
                       : NULL;

    return tv && tv->io && g_atomic_int_get(&tv->io->alive);
}

void bta_terminal_win32_write(BtaWidget *w, const char *s, size_t len)
{
    TermView *tv = w->inner
                       ? g_object_get_data(G_OBJECT(w->inner), TERM_VIEW_KEY)
                       : NULL;

    if (tv)
        term_view_feed(tv, s, len);
}

void bta_terminal_win32_reset(BtaWidget *w)
{
    TermView *tv = w->inner
                       ? g_object_get_data(G_OBJECT(w->inner), TERM_VIEW_KEY)
                       : NULL;

    if (!tv)
        return;

    while (!g_queue_is_empty(tv->scrollback))
        term_line_free(g_queue_pop_head(tv->scrollback));
    tv->scroll_offset = 0;
    term_view_clear_selection(tv);
    vterm_screen_reset(tv->screen, 1);
    term_view_update_bar(tv);
    term_view_queue_draw(tv);
}

char *bta_terminal_win32_read(BtaWidget *w)
{
    TermView *tv = w->inner
                       ? g_object_get_data(G_OBJECT(w->inner), TERM_VIEW_KEY)
                       : NULL;

    return tv ? term_view_read(tv) : g_strdup("");
}

bool bta_terminal_win32_pattern(JSContext *ctx, BtaWidget *w,
                                const char *pattern)
{
    TermView *tv = w->inner
                       ? g_object_get_data(G_OBJECT(w->inner), TERM_VIEW_KEY)
                       : NULL;

    if (!tv)
        return true;

    if (!*pattern) {
        g_clear_pointer(&tv->link, g_regex_unref);
        g_clear_pointer(&tv->hover, g_free);
        return true;
    }

    GError *error = NULL;
    GRegex *regex = g_regex_new(pattern, G_REGEX_MULTILINE | G_REGEX_OPTIMIZE,
                                0, &error);

    if (!regex) {
        JS_ThrowRangeError(ctx, "LinkPattern: the pattern is not a valid "
                                "regular expression");
        g_clear_error(&error);
        return false;
    }
    g_clear_pointer(&tv->link, g_regex_unref);
    tv->link = regex;
    g_clear_pointer(&tv->hover, g_free);
    return true;
}

bool bta_terminal_win32_kill(BtaWidget *w, bool hard)
{
    TermView *tv = w->inner
                       ? g_object_get_data(G_OBJECT(w->inner), TERM_VIEW_KEY)
                       : NULL;

    if (!tv || !tv->io || !g_atomic_int_get(&tv->io->alive))
        return false;

    if (hard) {
        if (tv->io->job)
            TerminateJobObject(tv->io->job, 1);
        else if (tv->io->process)
            TerminateProcess(tv->io->process, 1);
    } else {
        term_send_ctrl_c(tv);
    }
    return true;
}

int bta_terminal_win32_get_scrollback(BtaWidget *w)
{
    TermView *tv = w->inner
                       ? g_object_get_data(G_OBJECT(w->inner), TERM_VIEW_KEY)
                       : NULL;

    return tv ? tv->scrollback_lines : 10000;
}

void bta_terminal_win32_set_scrollback(BtaWidget *w, int n)
{
    TermView *tv = w->inner
                       ? g_object_get_data(G_OBJECT(w->inner), TERM_VIEW_KEY)
                       : NULL;

    if (!tv)
        return;
    tv->scrollback_lines = n;
    term_view_trim_scrollback(tv);
    term_view_update_bar(tv);
    term_view_queue_draw(tv);
}

double bta_terminal_win32_get_font_scale(BtaWidget *w)
{
    TermView *tv = w->inner
                       ? g_object_get_data(G_OBJECT(w->inner), TERM_VIEW_KEY)
                       : NULL;

    return tv ? tv->font_scale : 1.0;
}

void bta_terminal_win32_set_font_scale(BtaWidget *w, double scale)
{
    TermView *tv = w->inner
                       ? g_object_get_data(G_OBJECT(w->inner), TERM_VIEW_KEY)
                       : NULL;

    if (!tv)
        return;
    tv->font_scale = scale;
    term_metrics(tv);
    term_view_queue_draw(tv);
}

#endif /* G_OS_WIN32 && BTA_HAVE_LIBVTERM */
