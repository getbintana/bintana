/*
 * The Linux tray: `org.kde.StatusNotifierItem` and `com.canonical.dbusmenu`
 * over the session bus.
 *
 * GTK4 has no tray API and `GtkStatusIcon` is gone.  The desktop-native object
 * is a D-Bus service: this file owns `org.kde.StatusNotifierItem-<pid>-<n>`,
 * exports `/StatusNotifierItem` and `/MenuBar`, and registers the first with
 * the desktop's `StatusNotifierWatcher`.  The menu is the `dbusmenu` tree a
 * panel or shell draws itself; the tray never creates a window for it.
 *
 * The dbusmenu subset is deliberately small: `GetLayout`,
 * `GetGroupProperties`, `GetProperty`, `Event`, `AboutToShow`,
 * `AboutToShowGroup`, and the `LayoutUpdated` and `ItemsPropertiesUpdated`
 * signals.  No `libdbusmenu-glib`: the tree is the one `bta_tray.c` already
 * validated.
 */
#include "bta_tray.h"

#include <gio/gio.h>
#include <string.h>
#include <unistd.h>

#define SNI_PATH  "/StatusNotifierItem"
#define MENU_PATH "/MenuBar"

static const char *sni_xml =
    "<node>"
    " <interface name='org.kde.StatusNotifierItem'>"
    "  <property name='Category' type='s' access='read'/>"
    "  <property name='Id' type='s' access='read'/>"
    "  <property name='Title' type='s' access='read'/>"
    "  <property name='Status' type='s' access='read'/>"
    "  <property name='WindowId' type='i' access='read'/>"
    "  <property name='IconName' type='s' access='read'/>"
    "  <property name='IconPixmap' type='a(iiay)' access='read'/>"
    "  <property name='OverlayIconName' type='s' access='read'/>"
    "  <property name='OverlayIconPixmap' type='a(iiay)' access='read'/>"
    "  <property name='AttentionIconName' type='s' access='read'/>"
    "  <property name='AttentionIconPixmap' type='a(iiay)' access='read'/>"
    "  <property name='AttentionMovieName' type='s' access='read'/>"
    "  <property name='ToolTip' type='(sa(iiay)ss)' access='read'/>"
    "  <property name='ItemIsMenu' type='b' access='read'/>"
    "  <property name='Menu' type='o' access='read'/>"
    "  <method name='ContextMenu'>"
    "   <arg type='i' direction='in'/><arg type='i' direction='in'/>"
    "  </method>"
    "  <method name='Activate'>"
    "   <arg type='i' direction='in'/><arg type='i' direction='in'/>"
    "  </method>"
    "  <method name='SecondaryActivate'>"
    "   <arg type='i' direction='in'/><arg type='i' direction='in'/>"
    "  </method>"
    "  <method name='Scroll'>"
    "   <arg type='i' direction='in'/><arg type='s' direction='in'/>"
    "  </method>"
    "  <signal name='NewTitle'/>"
    "  <signal name='NewIcon'/>"
    "  <signal name='NewAttentionIcon'/>"
    "  <signal name='NewOverlayIcon'/>"
    "  <signal name='NewToolTip'/>"
    "  <signal name='NewStatus'><arg type='s'/></signal>"
    " </interface>"
    "</node>";

static const char *menu_xml =
    "<node>"
    " <interface name='com.canonical.dbusmenu'>"
    "  <property name='Version' type='u' access='read'/>"
    "  <property name='TextDirection' type='s' access='read'/>"
    "  <property name='Status' type='s' access='read'/>"
    "  <property name='IconThemePath' type='as' access='read'/>"
    "  <method name='GetLayout'>"
    "   <arg type='i' name='parentId' direction='in'/>"
    "   <arg type='i' name='recursionDepth' direction='in'/>"
    "   <arg type='as' name='propertyNames' direction='in'/>"
    "   <arg type='u' name='revision' direction='out'/>"
    "   <arg type='(ia{sv}av)' name='layout' direction='out'/>"
    "  </method>"
    "  <method name='GetGroupProperties'>"
    "   <arg type='ai' name='ids' direction='in'/>"
    "   <arg type='as' name='propertyNames' direction='in'/>"
    "   <arg type='a(ia{sv})' name='properties' direction='out'/>"
    "  </method>"
    "  <method name='GetProperty'>"
    "   <arg type='i' name='id' direction='in'/>"
    "   <arg type='s' name='name' direction='in'/>"
    "   <arg type='v' name='value' direction='out'/>"
    "  </method>"
    "  <method name='Event'>"
    "   <arg type='i' name='id' direction='in'/>"
    "   <arg type='s' name='eventId' direction='in'/>"
    "   <arg type='v' name='data' direction='in'/>"
    "   <arg type='u' name='timestamp' direction='in'/>"
    "  </method>"
    "  <method name='EventGroup'>"
    "   <arg type='a(isvu)' name='events' direction='in'/>"
    "   <arg type='ai' name='idErrors' direction='out'/>"
    "  </method>"
    "  <method name='AboutToShow'>"
    "   <arg type='i' name='id' direction='in'/>"
    "   <arg type='b' name='needUpdate' direction='out'/>"
    "  </method>"
    "  <method name='AboutToShowGroup'>"
    "   <arg type='ai' name='ids' direction='in'/>"
    "   <arg type='ai' name='updatesNeeded' direction='out'/>"
    "   <arg type='ai' name='idErrors' direction='out'/>"
    "  </method>"
    "  <signal name='ItemsPropertiesUpdated'>"
    "   <arg type='a(ia{sv})' name='updatedProps'/>"
    "   <arg type='a(ias)' name='removedProps'/>"
    "  </signal>"
    "  <signal name='LayoutUpdated'>"
    "   <arg type='u' name='revision'/>"
    "   <arg type='i' name='parent'/>"
    "  </signal>"
    "  <signal name='ItemActivationRequested'>"
    "   <arg type='i' name='id'/>"
    "   <arg type='u' name='timestamp'/>"
    "  </signal>"
    " </interface>"
    "</node>";

typedef struct {
    BtaTray         *tray;
    GDBusConnection *bus;
    char            *name;
    GDBusNodeInfo   *sni_node;
    GDBusNodeInfo   *menu_node;
    guint            sni_reg;
    guint            menu_reg;
    guint            revision;
    guint            next_id;
} LinuxTray;

static guint tray_name_counter;

static bool tray_linux_available(void)
{
    GError          *err = NULL;
    GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &err);

    if (!bus) {
        g_clear_error(&err);
        return false;
    }

    GVariant *r = g_dbus_connection_call_sync(
        bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
        "org.freedesktop.DBus", "NameHasOwner",
        g_variant_new("(s)", "org.kde.StatusNotifierWatcher"),
        G_VARIANT_TYPE("(b)"), G_DBUS_CALL_FLAGS_NONE, 1000, NULL, &err);

    bool has = false;

    if (r) {
        g_variant_get(r, "(b)", &has);
        g_variant_unref(r);
    }
    g_clear_error(&err);
    g_object_unref(bus);
    return has;
}

static const char *tray_linux_reason(void)
{
    return "this desktop has no StatusNotifierWatcher, so a tray icon cannot "
           "be shown (GNOME needs its AppIndicator extension)";
}

static bool tray_linux_can_menu(void)
{
    return true;
}

static char *tray_icon_name(const char *icon)
{
    if (!icon || !*icon)
        return g_strdup("");
    if (!strchr(icon, '/'))
        return g_strdup(icon);

    char *base = g_path_get_basename(icon);
    char *dot  = strrchr(base, '.');

    if (dot)
        *dot = 0;
    return base;
}

static char *tray_icon_path(const char *icon)
{
    if (icon && strchr(icon, '/'))
        return g_path_get_dirname(icon);
    return g_strdup("");
}

static const char *tray_app_id(void)
{
    BtaApp *app = bta_current_app();

    if (app && app->id && *app->id)
        return app->id;
    return g_get_prgname() ? g_get_prgname() : "bintana";
}

static const char *tray_app_name(void)
{
    BtaApp *app = bta_current_app();

    if (app && app->name && *app->name)
        return app->name;
    return g_get_application_name() ? g_get_application_name() : "Bintana";
}

static void tray_linux_emit(LinuxTray *lt, const char *signal,
                            GVariant *params)
{
    if (!lt->bus)
        return;
    g_dbus_connection_emit_signal(lt->bus, NULL, SNI_PATH,
                                  "org.kde.StatusNotifierItem", signal,
                                  params, NULL);
}

static GVariant *empty_pixmaps(void)
{
    return g_variant_new_array(G_VARIANT_TYPE("(iiay)"), NULL, 0);
}

static GVariant *tray_linux_tooltip(LinuxTray *lt)
{
    char *icon = tray_icon_name(lt->tray->icon);
    GVariant *tip = g_variant_new("(s@a(iiay)ss)", icon, empty_pixmaps(),
                                  tray_app_name(),
                                  lt->tray->tooltip ? lt->tray->tooltip : "");
    g_free(icon);
    return tip;
}

static GVariant *tray_linux_get_property(GDBusConnection *conn,
                                         const char *sender,
                                         const char *path,
                                         const char *interface,
                                         const char *property,
                                         GError **error,
                                         gpointer user_data)
{
    LinuxTray *lt = user_data;
    (void)conn; (void)sender; (void)path; (void)interface;

    if (strcmp(property, "Category") == 0)
        return g_variant_new_string("ApplicationStatus");
    if (strcmp(property, "Id") == 0)
        return g_variant_new_string(tray_app_id());
    if (strcmp(property, "Title") == 0)
        return g_variant_new_string(tray_app_name());
    if (strcmp(property, "Status") == 0)
        return g_variant_new_string(lt->tray->visible ? "Active" : "Passive");
    if (strcmp(property, "WindowId") == 0)
        return g_variant_new_int32(0);
    if (strcmp(property, "IconName") == 0) {
        char *name = tray_icon_name(lt->tray->icon);
        GVariant *v = g_variant_new_string(name);
        g_free(name);
        return v;
    }
    if (strcmp(property, "IconPixmap") == 0 ||
        strcmp(property, "OverlayIconPixmap") == 0 ||
        strcmp(property, "AttentionIconPixmap") == 0)
        return empty_pixmaps();
    if (strcmp(property, "OverlayIconName") == 0 ||
        strcmp(property, "AttentionIconName") == 0 ||
        strcmp(property, "AttentionMovieName") == 0)
        return g_variant_new_string("");
    if (strcmp(property, "ToolTip") == 0)
        return tray_linux_tooltip(lt);
    if (strcmp(property, "ItemIsMenu") == 0)
        return g_variant_new_boolean(lt->tray->menu && lt->tray->menu->len > 0);
    if (strcmp(property, "Menu") == 0)
        return g_variant_new_object_path(MENU_PATH);

    g_set_error(error, G_DBUS_ERROR, G_DBUS_ERROR_UNKNOWN_PROPERTY,
                "no property %s", property);
    return NULL;
}

static void tray_linux_sni_call(GDBusConnection *conn, const char *sender,
                                const char *path, const char *interface,
                                const char *method, GVariant *parameters,
                                GDBusMethodInvocation *invocation,
                                gpointer user_data)
{
    LinuxTray *lt = user_data;
    (void)conn; (void)sender; (void)path; (void)interface; (void)parameters;

    if (strcmp(method, "Activate") == 0 ||
        strcmp(method, "SecondaryActivate") == 0)
        bta_tray_emit_click(lt->tray);
    /* ContextMenu is the host asking the application to draw its own menu;
     * the menu is exported, so there is nothing to draw. */
    g_dbus_method_invocation_return_value(invocation, NULL);
}

static const GDBusInterfaceVTable sni_vtable = {
    .method_call  = tray_linux_sni_call,
    .get_property = tray_linux_get_property,
    .set_property = NULL,
};

/* ---------------------------------------------------------------- menu */

static void menu_assign_ids(BtaTrayItem *item, guint *next)
{
    item->id = ++*next;
    for (guint i = 0; i < item->children->len; i++)
        menu_assign_ids(g_ptr_array_index(item->children, i), next);
}

static BtaTrayItem *menu_find(LinuxTray *lt, int id)
{
    if (id == 0)
        return NULL;
    for (guint i = 0; i < lt->tray->menu->len; i++) {
        BtaTrayItem *item = g_ptr_array_index(lt->tray->menu, i);

        if (item->id == (guint)id)
            return item;
        /* depth-first, the same order the ids were assigned in */
        BtaTrayItem *found = NULL;
        GQueue *q = g_queue_new();
        g_queue_push_tail(q, item);
        while (!g_queue_is_empty(q)) {
            BtaTrayItem *it = g_queue_pop_head(q);

            if (it->id == (guint)id) {
                found = it;
                break;
            }
            for (guint j = 0; j < it->children->len; j++)
                g_queue_push_tail(q, g_ptr_array_index(it->children, j));
        }
        g_queue_free(q);
        if (found)
            return found;
    }
    return NULL;
}

static void menu_props(BtaTrayItem *item, GVariantBuilder *b)
{
    if (!item->separator) {
        g_variant_builder_add(b, "{sv}", "label",
                              g_variant_new_string(item->text));
        g_variant_builder_add(b, "{sv}", "enabled",
                              g_variant_new_boolean(item->enabled));
        g_variant_builder_add(b, "{sv}", "visible",
                              g_variant_new_boolean(true));
    } else {
        g_variant_builder_add(b, "{sv}", "type",
                              g_variant_new_string("separator"));
    }
    if (!item->separator && item->children->len)
        g_variant_builder_add(b, "{sv}", "children-display",
                              g_variant_new_string("submenu"));
    if (item->checkable) {
        g_variant_builder_add(b, "{sv}", "toggle-type",
                              g_variant_new_string("check"));
        g_variant_builder_add(b, "{sv}", "toggle-state",
                              g_variant_new_int32(item->checked ? 1 : 0));
    }
}

static GVariant *menu_layout(LinuxTray *lt, BtaTrayItem *item, int id,
                             int depth)
{
    GVariantBuilder props;

    g_variant_builder_init(&props, G_VARIANT_TYPE("a{sv}"));
    if (item)
        menu_props(item, &props);

    GVariantBuilder children;

    g_variant_builder_init(&children, G_VARIANT_TYPE("av"));
    if (depth != 0) {
        GPtrArray *list = item ? item->children : lt->tray->menu;

        for (guint i = 0; i < list->len; i++) {
            BtaTrayItem *child = g_ptr_array_index(list, i);

            g_variant_builder_add(&children, "v",
                                  menu_layout(lt, child, (int)child->id,
                                              depth < 0 ? -1 : depth - 1));
        }
    }

    return g_variant_new("(i@a{sv}@av)", id, g_variant_builder_end(&props),
                         g_variant_builder_end(&children));
}

static GVariant *menu_get_layout(LinuxTray *lt, int parent, int depth,
                                 GError **error)
{
    BtaTrayItem *item = parent == 0 ? NULL : menu_find(lt, parent);

    if (parent != 0 && !item) {
        g_set_error(error, G_DBUS_ERROR, G_DBUS_ERROR_INVALID_ARGS,
                    "no menu item %d", parent);
        return NULL;
    }
    return menu_layout(lt, item, parent, depth);
}

static void menu_method_call(GDBusConnection *conn, const char *sender,
                             const char *path, const char *interface,
                             const char *method, GVariant *parameters,
                             GDBusMethodInvocation *invocation,
                             gpointer user_data)
{
    LinuxTray *lt = user_data;
    (void)conn; (void)sender; (void)path; (void)interface;

    if (strcmp(method, "GetLayout") == 0) {
        int      parent = 0, depth = 0;
        char   **names  = NULL;

        g_variant_get(parameters, "(ii^as)", &parent, &depth, &names);
        g_strfreev(names);

        GError   *err = NULL;
        GVariant *layout = menu_get_layout(lt, parent, depth, &err);

        if (!layout) {
            g_dbus_method_invocation_return_gerror(invocation, err);
            g_clear_error(&err);
            return;
        }
        g_dbus_method_invocation_return_value(
            invocation, g_variant_new("(u@(ia{sv}av))", lt->revision, layout));
        return;
    }

    if (strcmp(method, "GetGroupProperties") == 0) {
        GVariant     *ids = NULL;
        char        **names = NULL;
        GVariantIter  iter;
        GVariantBuilder out;
        int           id;

        g_variant_get(parameters, "(@ai^as)", &ids, &names);
        g_strfreev(names);
        g_variant_builder_init(&out, G_VARIANT_TYPE("a(ia{sv})"));
        g_variant_iter_init(&iter, ids);
        while (g_variant_iter_next(&iter, "i", &id)) {
            BtaTrayItem *item = menu_find(lt, id);
            GVariantBuilder props;

            if (!item)
                continue;
            g_variant_builder_init(&props, G_VARIANT_TYPE("a{sv}"));
            menu_props(item, &props);
            g_variant_builder_add(&out, "(i@a{sv})", id,
                                  g_variant_builder_end(&props));
        }
        g_variant_unref(ids);
        g_dbus_method_invocation_return_value(
            invocation, g_variant_new("(@a(ia{sv}))",
                                      g_variant_builder_end(&out)));
        return;
    }

    if (strcmp(method, "GetProperty") == 0) {
        int         id = 0;
        const char *name = NULL;

        g_variant_get(parameters, "(i&s)", &id, &name);
        BtaTrayItem *item = menu_find(lt, id);

        if (!item) {
            g_dbus_method_invocation_return_dbus_error(
                invocation, "com.canonical.dbusmenu.Error.InvalidId",
                "no menu item");
            return;
        }
        GVariantBuilder props;

        g_variant_builder_init(&props, G_VARIANT_TYPE("a{sv}"));
        menu_props(item, &props);
        GVariant *dict = g_variant_builder_end(&props);
        GVariant *v    = g_variant_lookup_value(dict, name, NULL);

        if (!v) {
            g_variant_unref(dict);
            g_dbus_method_invocation_return_dbus_error(
                invocation, "com.canonical.dbusmenu.Error.InvalidProperty",
                "no property");
            return;
        }
        g_variant_unref(dict);
        g_dbus_method_invocation_return_value(invocation,
                                              g_variant_new("(v)", v));
        return;
    }

    if (strcmp(method, "Event") == 0) {
        int         id = 0;
        const char *event = NULL;
        GVariant   *data = NULL;
        guint32     when = 0;

        g_variant_get(parameters, "(i&s@vu)", &id, &event, &data, &when);
        if (strcmp(event, "clicked") == 0) {
            BtaTrayItem *item = menu_find(lt, id);

            if (item && item->action && *item->action)
                bta_tray_emit_menu(lt->tray, item->action);
        }
        g_variant_unref(data);
        g_dbus_method_invocation_return_value(invocation, NULL);
        return;
    }

    if (strcmp(method, "EventGroup") == 0) {
        GVariantIter iter;
        GVariant    *events = NULL;
        int          id;
        const char  *event;
        GVariant    *data;
        guint32      when;

        g_variant_get(parameters, "(@a(isvu))", &events);
        g_variant_iter_init(&iter, events);
        while (g_variant_iter_next(&iter, "(i&s@vu)", &id, &event, &data,
                                   &when)) {
            if (strcmp(event, "clicked") == 0) {
                BtaTrayItem *item = menu_find(lt, id);

                if (item && item->action && *item->action)
                    bta_tray_emit_menu(lt->tray, item->action);
            }
            g_variant_unref(data);
        }
        g_variant_unref(events);
        g_dbus_method_invocation_return_value(
            invocation, g_variant_new("(@ai)", g_variant_new_array(
                G_VARIANT_TYPE("i"), NULL, 0)));
        return;
    }

    if (strcmp(method, "AboutToShow") == 0) {
        g_dbus_method_invocation_return_value(invocation,
                                              g_variant_new("(b)", false));
        return;
    }

    if (strcmp(method, "AboutToShowGroup") == 0) {
        g_dbus_method_invocation_return_value(
            invocation, g_variant_new("(@ai@ai)",
                g_variant_new_array(G_VARIANT_TYPE("i"), NULL, 0),
                g_variant_new_array(G_VARIANT_TYPE("i"), NULL, 0)));
        return;
    }

    g_dbus_method_invocation_return_dbus_error(invocation,
        "org.freedesktop.DBus.Error.UnknownMethod", "no such menu method");
}

static GVariant *menu_get_property(GDBusConnection *conn, const char *sender,
                                   const char *path, const char *interface,
                                   const char *property, GError **error,
                                   gpointer user_data)
{
    LinuxTray *lt = user_data;
    (void)conn; (void)sender; (void)path; (void)interface;

    if (strcmp(property, "Version") == 0)
        return g_variant_new_uint32(3);
    if (strcmp(property, "TextDirection") == 0)
        return g_variant_new_string("ltr");
    if (strcmp(property, "Status") == 0)
        return g_variant_new_string("normal");
    if (strcmp(property, "IconThemePath") == 0) {
        GVariantBuilder b;
        char *path = tray_icon_path(lt->tray->icon);

        g_variant_builder_init(&b, G_VARIANT_TYPE("as"));
        if (*path)
            g_variant_builder_add(&b, "s", path);
        g_free(path);
        return g_variant_builder_end(&b);
    }
    g_set_error(error, G_DBUS_ERROR, G_DBUS_ERROR_UNKNOWN_PROPERTY,
                "no property %s", property);
    return NULL;
}

static const GDBusInterfaceVTable menu_vtable = {
    .method_call  = menu_method_call,
    .get_property = menu_get_property,
    .set_property = NULL,
};

/* ------------------------------------------------------------ lifecycle */

static bool tray_linux_register_objects(LinuxTray *lt)
{
    GError *err = NULL;

    lt->sni_node = g_dbus_node_info_new_for_xml(sni_xml, &err);
    if (!lt->sni_node) {
        g_clear_error(&err);
        return false;
    }
    lt->menu_node = g_dbus_node_info_new_for_xml(menu_xml, &err);
    if (!lt->menu_node) {
        g_clear_error(&err);
        return false;
    }

    GDBusInterfaceInfo *sni = g_dbus_node_info_lookup_interface(
        lt->sni_node, "org.kde.StatusNotifierItem");
    GDBusInterfaceInfo *menu = g_dbus_node_info_lookup_interface(
        lt->menu_node, "com.canonical.dbusmenu");

    if (!sni || !menu)
        return false;

    lt->sni_reg = g_dbus_connection_register_object(
        lt->bus, SNI_PATH, sni, &sni_vtable, lt, NULL, &err);
    if (!lt->sni_reg) {
        g_clear_error(&err);
        return false;
    }
    lt->menu_reg = g_dbus_connection_register_object(
        lt->bus, MENU_PATH, menu, &menu_vtable, lt, NULL, &err);
    if (!lt->menu_reg) {
        g_clear_error(&err);
        return false;
    }
    return true;
}

static bool tray_linux_create(BtaTray *tray)
{
    LinuxTray *lt = g_new0(LinuxTray, 1);
    GError    *err = NULL;

    lt->tray = tray;
    lt->next_id = 0;
    lt->revision = 1;
    tray->impl = lt;

    lt->bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &err);
    if (!lt->bus)
        goto fail;

    lt->name = g_strdup_printf("org.kde.StatusNotifierItem-%d-%u",
                               (int)getpid(), ++tray_name_counter);

    GVariant *owned = g_dbus_connection_call_sync(
        lt->bus, "org.freedesktop.DBus", "/org/freedesktop/DBus",
        "org.freedesktop.DBus", "RequestName",
        g_variant_new("(su)", lt->name, 0), G_VARIANT_TYPE("(u)"),
        G_DBUS_CALL_FLAGS_NONE, 1000, NULL, &err);

    if (!owned)
        goto fail;

    guint32 answer = 0;

    g_variant_get(owned, "(u)", &answer);
    g_variant_unref(owned);
    if (answer != 1 && answer != 4)
        goto fail;

    if (!tray_linux_register_objects(lt))
        goto fail;

    GVariant *registered = g_dbus_connection_call_sync(
        lt->bus, "org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher",
        "org.kde.StatusNotifierWatcher", "RegisterStatusNotifierItem",
        g_variant_new("(s)", lt->name), NULL, G_DBUS_CALL_FLAGS_NONE,
        1000, NULL, &err);

    if (!registered)
        goto fail;
    g_variant_unref(registered);
    return true;

fail:
    g_clear_error(&err);
    if (lt->sni_reg && lt->bus)
        g_dbus_connection_unregister_object(lt->bus, lt->sni_reg);
    if (lt->menu_reg && lt->bus)
        g_dbus_connection_unregister_object(lt->bus, lt->menu_reg);
    if (lt->bus && lt->name)
        g_dbus_connection_call_sync(lt->bus, "org.freedesktop.DBus",
            "/org/freedesktop/DBus", "org.freedesktop.DBus", "ReleaseName",
            g_variant_new("(s)", lt->name), NULL, G_DBUS_CALL_FLAGS_NONE,
            1000, NULL, NULL);
    if (lt->sni_node)
        g_dbus_node_info_unref(lt->sni_node);
    if (lt->menu_node)
        g_dbus_node_info_unref(lt->menu_node);
    g_free(lt->name);
    if (lt->bus)
        g_object_unref(lt->bus);
    g_free(lt);
    tray->impl = NULL;
    return false;
}

static void tray_linux_destroy(BtaTray *tray)
{
    LinuxTray *lt = tray->impl;

    if (!lt)
        return;
    if (lt->sni_reg && lt->bus)
        g_dbus_connection_unregister_object(lt->bus, lt->sni_reg);
    if (lt->menu_reg && lt->bus)
        g_dbus_connection_unregister_object(lt->bus, lt->menu_reg);
    if (lt->bus && lt->name)
        g_dbus_connection_call_sync(lt->bus, "org.freedesktop.DBus",
            "/org/freedesktop/DBus", "org.freedesktop.DBus", "ReleaseName",
            g_variant_new("(s)", lt->name), NULL, G_DBUS_CALL_FLAGS_NONE,
            1000, NULL, NULL);
    if (lt->sni_node)
        g_dbus_node_info_unref(lt->sni_node);
    if (lt->menu_node)
        g_dbus_node_info_unref(lt->menu_node);
    g_free(lt->name);
    if (lt->bus)
        g_object_unref(lt->bus);
    g_free(lt);
    tray->impl = NULL;
}

static void tray_linux_set_icon(BtaTray *tray, const char *icon)
{
    LinuxTray *lt = tray->impl;

    (void)icon;
    if (lt)
        tray_linux_emit(lt, "NewIcon", NULL);
}

static void tray_linux_set_tooltip(BtaTray *tray, const char *tooltip)
{
    LinuxTray *lt = tray->impl;

    (void)tooltip;
    if (lt)
        tray_linux_emit(lt, "NewToolTip", NULL);
}

static void tray_linux_set_menu(BtaTray *tray)
{
    LinuxTray *lt = tray->impl;

    if (!lt)
        return;
    lt->next_id = 0;
    for (guint i = 0; i < tray->menu->len; i++)
        menu_assign_ids(g_ptr_array_index(tray->menu, i), &lt->next_id);
    lt->revision++;
    if (lt->bus)
        g_dbus_connection_emit_signal(
            lt->bus, NULL, MENU_PATH, "com.canonical.dbusmenu",
            "LayoutUpdated", g_variant_new("(ui)", lt->revision, 0), NULL);
}

static void tray_linux_show(BtaTray *tray)
{
    LinuxTray *lt = tray->impl;

    if (lt)
        tray_linux_emit(lt, "NewStatus", g_variant_new("(s)", "Active"));
}

static void tray_linux_hide(BtaTray *tray)
{
    LinuxTray *lt = tray->impl;

    if (lt)
        tray_linux_emit(lt, "NewStatus", g_variant_new("(s)", "Passive"));
}

const BtaTrayBackend bta_tray_backend = {
    .available   = tray_linux_available,
    .reason      = tray_linux_reason,
    .can_menu    = tray_linux_can_menu,
    .create      = tray_linux_create,
    .destroy     = tray_linux_destroy,
    .set_icon    = tray_linux_set_icon,
    .set_tooltip = tray_linux_set_tooltip,
    .set_menu    = tray_linux_set_menu,
    .show        = tray_linux_show,
    .hide        = tray_linux_hide,
};
