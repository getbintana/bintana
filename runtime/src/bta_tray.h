/*
 * The tray, between the JavaScript object and the three native backends.
 *
 * `bta_tray.c` owns the public surface and the validated menu tree;
 * `bta_tray_linux.c` exports `org.kde.StatusNotifierItem` and
 * `com.canonical.dbusmenu`; the Windows and macOS files are the other two
 * implementations of `BtaTrayBackend`.  Nothing here is a widget: a tray
 * outlives the form that made it.
 */
#ifndef BTA_TRAY_H
#define BTA_TRAY_H

#include "bta.h"

typedef struct BtaTray     BtaTray;
typedef struct BtaTrayItem BtaTrayItem;

struct BtaTrayItem {
    char      *text;       /* prose, already translated by the caller */
    char      *action;     /* the key OnMenu is handed; "" for a submenu */
    bool       enabled;
    bool       checkable;  /* the caller gave Checked */
    bool       checked;
    bool       separator;
    guint      id;         /* the backend's, assigned when the menu is built */
    GPtrArray *children;   /* BtaTrayItem *, owned */
};

struct BtaTray {
    JSContext *ctx;
    JSValue    self;       /* BORROWED: the wrapper owns this struct */
    JSValue    on_click;
    JSValue    on_menu;
    JSValue    menu_src;   /* the array the caller assigned, for Menu */
    char      *icon;
    char      *tooltip;
    GPtrArray *menu;       /* BtaTrayItem *, owned */
    bool       visible;
    void      *impl;       /* the backend's own */
};

/* The same shape for all three.  `set_menu` reads `tray->menu`; a backend
 * assigns the ids it wants and frees nothing. */
typedef struct {
    bool (*available)(void);
    const char *(*reason)(void);   /* why `available` is false */
    bool (*can_menu)(void);
    bool (*create)(BtaTray *tray);
    void (*destroy)(BtaTray *tray);
    void (*set_icon)(BtaTray *tray, const char *icon);
    void (*set_tooltip)(BtaTray *tray, const char *tooltip);
    void (*set_menu)(BtaTray *tray);
    void (*show)(BtaTray *tray);
    void (*hide)(BtaTray *tray);
} BtaTrayBackend;

extern const BtaTrayBackend bta_tray_backend;

void bta_tray_emit_click(BtaTray *tray);
void bta_tray_emit_menu(BtaTray *tray, const char *action);
void bta_tray_item_free(gpointer p);

#endif
