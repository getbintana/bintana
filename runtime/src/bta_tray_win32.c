/*
 * The Windows tray backend: `Shell_NotifyIcon` and an `HMENU`.
 *
 * The plan is `docs/plans/tray-plan.md`.  The icon belongs to a hidden
 * top-level window on the main thread -- top-level and not `HWND_MESSAGE`
 * because `TaskbarCreated` is a broadcast, and a message-only window never
 * hears one.  GTK's own message pump dispatches this window's messages, so the
 * GLib loop keeps running while the icon sits beside the clock.
 *
 * The menu is rebuilt from `tray->menu` on every assignment, with the item ids
 * assigned here (the common code leaves them to the backend).  `Text` is
 * UTF-8 from JavaScript and goes to `AppendMenuW` through GLib's UTF-16.
 */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "bta_tray.h"

#include <windows.h>
#include <shellapi.h>
#include <wchar.h>

#ifndef NIN_SELECT
#define NIN_SELECT (WM_USER + 0)
#endif
#ifndef NIN_KEYSELECT
#define NIN_KEYSELECT (WM_USER + 1)
#endif

#define BTA_TRAY_WINDOW_CLASS L"BintanaTrayWindow"
#define BTA_TRAY_CALLBACK     (WM_APP + 1)
#define BTA_TRAY_ID           1

typedef struct {
    BtaTray         *tray;
    HWND             hwnd;
    NOTIFYICONDATAW  nid;
    HMENU            menu;
    HICON            icon;
    bool             icon_owned;   /* DestroyIcon when replaced */
    bool             added;        /* NIM_ADD succeeded and not deleted */
    bool             version4;     /* NIM_SETVERSION took NOTIFYICON_VERSION_4 */
    UINT             taskbar_created;
} WinTray;

static bool window_class_ready;

/* --------------------------------------------------------------- the icon */

static int tray_icon_size(void)
{
    int size = GetSystemMetrics(SM_CXSMICON);

    return size > 0 ? size : 16;
}

/* A GdkPixbuf is RGBA in bytes; a Windows icon is a 32-bit DIB with a mask.
 * The alpha channel is what makes a rounded icon stay rounded on the taskbar,
 * and the mask stays empty because every pixel carries its own alpha. */
static HICON tray_icon_from_pixbuf(GdkPixbuf *pixbuf)
{
    int      width  = gdk_pixbuf_get_width(pixbuf);
    int      height = gdk_pixbuf_get_height(pixbuf);
    int      stride = gdk_pixbuf_get_rowstride(pixbuf);
    int      channels = gdk_pixbuf_get_n_channels(pixbuf);
    gboolean alpha  = gdk_pixbuf_get_has_alpha(pixbuf);
    guchar  *src    = gdk_pixbuf_get_pixels(pixbuf);
    BITMAPV5HEADER bi = { 0 };
    HDC      hdc;
    HBITMAP  color, mask;
    HICON    icon;
    void    *bits = NULL;
    ICONINFO ii = { 0 };

    if (width <= 0 || height <= 0)
        return NULL;

    bi.bV5Size        = sizeof(bi);
    bi.bV5Width       = width;
    bi.bV5Height      = -height;   /* top-down, the order GdkPixbuf has */
    bi.bV5Planes      = 1;
    bi.bV5BitCount    = 32;
    bi.bV5Compression = BI_BITFIELDS;
    bi.bV5RedMask     = 0x00FF0000;
    bi.bV5GreenMask   = 0x0000FF00;
    bi.bV5BlueMask    = 0x000000FF;
    bi.bV5AlphaMask   = 0xFF000000;

    hdc = GetDC(NULL);
    color = CreateDIBSection(hdc, (BITMAPINFO *)&bi, DIB_RGB_COLORS,
                             &bits, NULL, 0);
    ReleaseDC(NULL, hdc);
    if (!color || !bits) {
        if (color)
            DeleteObject(color);
        return NULL;
    }

    for (int y = 0; y < height; y++) {
        const guchar *row = src + y * stride;
        guchar       *dst = (guchar *)bits + y * width * 4;

        for (int x = 0; x < width; x++) {
            dst[0] = row[2];                       /* B */
            dst[1] = row[1];                       /* G */
            dst[2] = row[0];                       /* R */
            dst[3] = alpha ? row[3] : 255;         /* A */
            row += channels;
            dst += 4;
        }
    }

    mask = CreateBitmap(width, height, 1, 1, NULL);
    ii.fIcon    = TRUE;
    ii.hbmMask  = mask;
    ii.hbmColor = color;
    icon = CreateIconIndirect(&ii);
    DeleteObject(color);
    if (mask)
        DeleteObject(mask);
    return icon;
}

static HICON tray_icon_from_file(const char *path)
{
    GError    *err = NULL;
    GdkPixbuf *pixbuf;
    HICON      icon;
    int        size = tray_icon_size();

    pixbuf = gdk_pixbuf_new_from_file_at_scale(path, size, size, TRUE, &err);
    if (!pixbuf) {
        g_clear_error(&err);
        return NULL;
    }
    icon = tray_icon_from_pixbuf(pixbuf);
    g_object_unref(pixbuf);
    return icon;
}

/* A name the icon theme knows -- the same name Linux is given -- becomes the
 * file the theme resolved and then an HICON.  The project's own `icons/`
 * directory is already in the theme by the time a form runs. */
static HICON tray_icon_from_name(const char *name)
{
    GdkDisplay      *display = gdk_display_get_default();
    GtkIconTheme    *theme;
    GtkIconPaintable *paintable;
    GFile           *file;
    HICON            icon = NULL;
    int              size = tray_icon_size();

    if (!display)
        return NULL;
    theme = gtk_icon_theme_get_for_display(display);
    paintable = gtk_icon_theme_lookup_icon(theme, name, NULL, size, 1,
                                           GTK_TEXT_DIR_NONE, 0);
    if (!paintable)
        return NULL;
    file = gtk_icon_paintable_get_file(paintable);
    if (file) {
        char *path = g_file_get_path(file);

        if (path) {
            icon = tray_icon_from_file(path);
            g_free(path);
        }
        g_object_unref(file);
    }
    g_object_unref(paintable);
    return icon;
}

static HICON tray_load_icon(const char *icon, bool *owned)
{
    *owned = false;

    if (icon && *icon) {
        HICON h = NULL;

        if (g_file_test(icon, G_FILE_TEST_EXISTS)) {
            gunichar2 *wide = g_utf8_to_utf16(icon, -1, NULL, NULL, NULL);

            if (wide) {
                h = LoadImageW(NULL, (LPCWSTR)wide, IMAGE_ICON, 0, 0,
                               LR_LOADFROMFILE | LR_DEFAULTSIZE);
                g_free(wide);
            }
            if (!h)
                h = tray_icon_from_file(icon);
        } else {
            h = tray_icon_from_name(icon);
        }
        if (h) {
            *owned = true;
            return h;
        }
    }

    HICON h = LoadIconW(GetModuleHandleW(NULL), MAKEINTRESOURCEW(1));
    if (!h)
        h = LoadIconW(NULL, (LPCWSTR)IDI_APPLICATION);
    return h;   /* shared: never DestroyIcon */
}

/* --------------------------------------------------------------- the menu */

static BtaTrayItem *tray_find_action(GPtrArray *items, UINT id)
{
    for (guint i = 0; i < items->len; i++) {
        BtaTrayItem *item = g_ptr_array_index(items, i);

        if (!item->separator) {
            if (item->id == id && item->action && *item->action)
                return item;
            if (item->children->len) {
                BtaTrayItem *found = tray_find_action(item->children, id);

                if (found)
                    return found;
            }
        }
    }
    return NULL;
}

static void tray_append_items(HMENU menu, GPtrArray *items, UINT *next_id)
{
    for (guint i = 0; i < items->len; i++) {
        BtaTrayItem *item = g_ptr_array_index(items, i);

        if (item->separator) {
            AppendMenuW(menu, MF_SEPARATOR, 0, NULL);
            continue;
        }

        gunichar2 *text = g_utf8_to_utf16(item->text ? item->text : "", -1,
                                          NULL, NULL, NULL);
        UINT flags = MF_STRING;

        if (!item->enabled)
            flags |= MF_GRAYED;
        if (item->checkable && item->checked)
            flags |= MF_CHECKED;

        if (item->children->len) {
            HMENU submenu = CreatePopupMenu();

            if (!submenu) {
                g_free(text);
                continue;
            }
            item->id = 0;   /* a submenu is not a command */
            tray_append_items(submenu, item->children, next_id);
            AppendMenuW(menu, flags | MF_POPUP, (UINT_PTR)submenu,
                        (LPCWSTR)text);
        } else {
            item->id = (*next_id)++;
            AppendMenuW(menu, flags, item->id, (LPCWSTR)text);
        }
        g_free(text);
    }
}

static HMENU tray_build_menu(BtaTray *tray, UINT *next_id)
{
    HMENU menu;

    if (!tray->menu->len)
        return NULL;
    menu = CreatePopupMenu();
    if (!menu)
        return NULL;
    *next_id = 1;
    tray_append_items(menu, tray->menu, next_id);
    return menu;
}

/* --------------------------------------------------------------- dispatch */

static void tray_dispatch(WinTray *wt, UINT id)
{
    BtaTrayItem *item;

    if (!wt || !wt->tray)
        return;
    item = tray_find_action(wt->tray->menu, id);
    if (item)
        bta_tray_emit_menu(wt->tray, item->action);
}

static void tray_popup(WinTray *wt)
{
    POINT pt;
    UINT  id;

    if (!wt || !wt->menu)
        return;

    /* The two lines Windows requires around a notification-area menu: the
     * foreground window owns the dismissal, and the posted WM_NULL is what
     * makes the menu close when the next click lands elsewhere. */
    SetForegroundWindow(wt->hwnd);
    GetCursorPos(&pt);
    id = TrackPopupMenu(wt->menu,
                        TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
                        pt.x, pt.y, 0, wt->hwnd, NULL);
    PostMessageW(wt->hwnd, WM_NULL, 0, 0);
    if (id)
        tray_dispatch(wt, id);
}

/* ------------------------------------------------------- the hidden window */

static LRESULT CALLBACK tray_wndproc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp)
{
    WinTray *wt = (WinTray *)GetWindowLongPtrW(hwnd, GWLP_USERDATA);

    if (msg == WM_NCCREATE) {
        CREATESTRUCTW *cs = (CREATESTRUCTW *)lp;

        SetWindowLongPtrW(hwnd, GWLP_USERDATA, (LONG_PTR)cs->lpCreateParams);
        return TRUE;
    }
    if (!wt)
        return DefWindowProcW(hwnd, msg, wp, lp);

    if (wt->taskbar_created && msg == wt->taskbar_created) {
        /* Explorer restarted: the icon is gone from its tray, and the shell
         * broadcasts the message that says so.  Put it back with the same
         * data; the object never stopped being visible. */
        if (wt->added) {
            wt->nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
            Shell_NotifyIconW(NIM_ADD, &wt->nid);
            wt->nid.uVersion = NOTIFYICON_VERSION_4;
            Shell_NotifyIconW(NIM_SETVERSION, &wt->nid);
        }
        return 0;
    }

    if (msg == BTA_TRAY_CALLBACK) {
        UINT event = LOWORD(lp);   /* version 4: the mouse message is here */

        if (event == NIN_SELECT || event == NIN_KEYSELECT ||
            (!wt->version4 && event == WM_LBUTTONUP)) {
            bta_tray_emit_click(wt->tray);
            return 0;
        }
        if (event == WM_CONTEXTMENU || event == WM_RBUTTONUP) {
            tray_popup(wt);
            return 0;
        }
        return 0;
    }

    if (msg == WM_COMMAND) {
        tray_dispatch(wt, LOWORD(wp));
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

static bool tray_window_class(void)
{
    WNDCLASSEXW wc = { 0 };

    if (window_class_ready)
        return true;
    wc.cbSize        = sizeof(wc);
    wc.lpfnWndProc   = tray_wndproc;
    wc.hInstance     = GetModuleHandleW(NULL);
    wc.lpszClassName = BTA_TRAY_WINDOW_CLASS;
    if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS)
        return false;
    window_class_ready = true;
    return true;
}

/* --------------------------------------------------------------- backend */

static bool tray_win32_available(void)
{
    return true;
}

static const char *tray_win32_reason(void)
{
    return "the Windows notification area is not available";
}

static bool tray_win32_can_menu(void)
{
    return true;
}

static bool tray_win32_create(BtaTray *tray)
{
    WinTray *wt;

    if (!tray_window_class())
        return false;

    wt = g_new0(WinTray, 1);
    wt->tray = tray;
    wt->taskbar_created = RegisterWindowMessageW(L"TaskbarCreated");
    tray->impl = wt;

    wt->hwnd = CreateWindowExW(WS_EX_TOOLWINDOW, BTA_TRAY_WINDOW_CLASS,
                               L"BintanaTray", WS_POPUP,
                               0, 0, 0, 0, NULL, NULL,
                               GetModuleHandleW(NULL), wt);
    if (!wt->hwnd) {
        g_free(wt);
        tray->impl = NULL;
        return false;
    }

    wt->nid.cbSize           = sizeof(wt->nid);
    wt->nid.hWnd             = wt->hwnd;
    wt->nid.uID              = BTA_TRAY_ID;
    wt->nid.uFlags           = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    wt->nid.uCallbackMessage = BTA_TRAY_CALLBACK;
    wt->nid.hIcon            = LoadIconW(NULL, (LPCWSTR)IDI_APPLICATION);
    wt->nid.szTip[0]         = 0;

    /* Add it here rather than in `show`: `create` is the function whose false
     * return the common code turns into a sentence, and a shell that refuses
     * the icon must not leave `Visible` saying true.  The icon is complete
     * before the same `Show` call returns -- set_icon/set_menu run next and
     * modify it in place. */
    if (!Shell_NotifyIconW(NIM_ADD, &wt->nid)) {
        DestroyWindow(wt->hwnd);
        g_free(wt);
        tray->impl = NULL;
        return false;
    }
    wt->nid.uVersion = NOTIFYICON_VERSION_4;
    wt->version4 = Shell_NotifyIconW(NIM_SETVERSION, &wt->nid) != FALSE;
    wt->added = true;
    return true;
}

static void tray_win32_destroy(BtaTray *tray)
{
    WinTray *wt = tray->impl;

    if (!wt)
        return;
    if (wt->added)
        Shell_NotifyIconW(NIM_DELETE, &wt->nid);
    if (wt->hwnd)
        DestroyWindow(wt->hwnd);
    if (wt->menu)
        DestroyMenu(wt->menu);
    if (wt->icon && wt->icon_owned)
        DestroyIcon(wt->icon);
    g_free(wt);
    tray->impl = NULL;
}

static void tray_win32_set_icon(BtaTray *tray, const char *icon)
{
    WinTray *wt = tray->impl;
    HICON    h;
    bool     owned;

    if (!wt)
        return;

    h = tray_load_icon(icon, &owned);
    if (wt->icon && wt->icon_owned)
        DestroyIcon(wt->icon);
    wt->icon       = h;
    wt->icon_owned = owned;
    wt->nid.hIcon  = h;

    if (wt->added) {
        wt->nid.uFlags = NIF_ICON;
        Shell_NotifyIconW(NIM_MODIFY, &wt->nid);
    }
}

static void tray_win32_set_tooltip(BtaTray *tray, const char *tooltip)
{
    WinTray    *wt = tray->impl;
    gunichar2  *wide;

    if (!wt)
        return;
    wide = g_utf8_to_utf16(tooltip ? tooltip : "", -1, NULL, NULL, NULL);
    if (wide) {
        wcsncpy(wt->nid.szTip, (LPCWSTR)wide,
                G_N_ELEMENTS(wt->nid.szTip) - 1);
        wt->nid.szTip[G_N_ELEMENTS(wt->nid.szTip) - 1] = 0;
        g_free(wide);
    } else {
        wt->nid.szTip[0] = 0;
    }

    if (wt->added) {
        wt->nid.uFlags = NIF_TIP;
        Shell_NotifyIconW(NIM_MODIFY, &wt->nid);
    }
}

static void tray_win32_set_menu(BtaTray *tray)
{
    WinTray *wt = tray->impl;
    HMENU    menu;
    UINT     next_id = 1;

    if (!wt)
        return;

    menu = tray_build_menu(tray, &next_id);
    if (wt->menu)
        DestroyMenu(wt->menu);
    wt->menu = menu;
}

static void tray_win32_show(BtaTray *tray)
{
    WinTray *wt = tray->impl;

    if (!wt || wt->added)
        return;

    wt->nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
    if (!Shell_NotifyIconW(NIM_ADD, &wt->nid))
        return;

    wt->nid.uVersion = NOTIFYICON_VERSION_4;
    wt->version4 = Shell_NotifyIconW(NIM_SETVERSION, &wt->nid) != FALSE;
    wt->added = true;
}

static void tray_win32_hide(BtaTray *tray)
{
    WinTray *wt = tray->impl;

    if (!wt || !wt->added)
        return;
    Shell_NotifyIconW(NIM_DELETE, &wt->nid);
    wt->added = false;
}

const BtaTrayBackend bta_tray_backend = {
    .available   = tray_win32_available,
    .reason      = tray_win32_reason,
    .can_menu    = tray_win32_can_menu,
    .create      = tray_win32_create,
    .destroy     = tray_win32_destroy,
    .set_icon    = tray_win32_set_icon,
    .set_tooltip = tray_win32_set_tooltip,
    .set_menu    = tray_win32_set_menu,
    .show        = tray_win32_show,
    .hide        = tray_win32_hide,
};
