/*
 * The Windows tray backend, not written yet.
 *
 * The plan is `docs/plans/tray-plan.md`: a hidden window, `Shell_NotifyIcon`
 * and an `HMENU`.  Until it lands the class exists, `Tray.Available` is false
 * and `Show` says so, so a `.form` or a program that carries a tray still
 * compiles and runs on Windows.
 */
#include "bta_tray.h"

static bool tray_win32_available(void) { return false; }
static const char *tray_win32_reason(void)
{
    return "the Windows tray backend is not built yet";
}
static bool tray_win32_can_menu(void)  { return false; }

static bool tray_win32_create(BtaTray *tray) { (void)tray; return false; }
static void tray_win32_destroy(BtaTray *tray) { (void)tray; }
static void tray_win32_set_icon(BtaTray *tray, const char *icon)
{ (void)tray; (void)icon; }
static void tray_win32_set_tooltip(BtaTray *tray, const char *tooltip)
{ (void)tray; (void)tooltip; }
static void tray_win32_set_menu(BtaTray *tray) { (void)tray; }
static void tray_win32_show(BtaTray *tray) { (void)tray; }
static void tray_win32_hide(BtaTray *tray) { (void)tray; }

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
