/*
 * The macOS tray backend, not written yet.
 *
 * The plan is `docs/plans/tray-plan.md`: `NSStatusItem` and `NSMenu`.  Until it
 * lands the class exists, `Tray.Available` is false and `Show` says so, so a
 * project that carries a tray still compiles and runs on macOS.
 */
#include "bta_tray.h"

static bool tray_cocoa_available(void) { return false; }
static const char *tray_cocoa_reason(void)
{
    return "the macOS tray backend is not built yet";
}
static bool tray_cocoa_can_menu(void)  { return false; }

static bool tray_cocoa_create(BtaTray *tray) { (void)tray; return false; }
static void tray_cocoa_destroy(BtaTray *tray) { (void)tray; }
static void tray_cocoa_set_icon(BtaTray *tray, const char *icon)
{ (void)tray; (void)icon; }
static void tray_cocoa_set_tooltip(BtaTray *tray, const char *tooltip)
{ (void)tray; (void)tooltip; }
static void tray_cocoa_set_menu(BtaTray *tray) { (void)tray; }
static void tray_cocoa_show(BtaTray *tray) { (void)tray; }
static void tray_cocoa_hide(BtaTray *tray) { (void)tray; }

const BtaTrayBackend bta_tray_backend = {
    .available   = tray_cocoa_available,
    .reason      = tray_cocoa_reason,
    .can_menu    = tray_cocoa_can_menu,
    .create      = tray_cocoa_create,
    .destroy     = tray_cocoa_destroy,
    .set_icon    = tray_cocoa_set_icon,
    .set_tooltip = tray_cocoa_set_tooltip,
    .set_menu    = tray_cocoa_set_menu,
    .show        = tray_cocoa_show,
    .hide        = tray_cocoa_hide,
};
