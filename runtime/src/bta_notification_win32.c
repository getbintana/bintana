/*
 * The Windows notification backend: a WinRT toast with actions.
 *
 * A WinRT toast belongs to an AppUserModelID, and an unpackaged program's
 * AUMID is registered by a Start Menu shortcut.  The first `Send` writes
 * `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Bintana\<id>.lnk` pointing
 * at this runtime with the project directory, and sets its
 * `System.AppUserModel.ID` to the project's `id`.  Without that shortcut
 * `CreateToastNotifier` answers "element not found" (measured); with it the
 * toast is delivered and its buttons work.
 *
 * The `Activated` event is in-process while the program runs: its handler
 * marshals the action to the main loop, where `Notification.OnActivate` is
 * looked up.  A click when the program is not running launches it through the
 * shortcut but carries no action; that is the COM-activator half this backend
 * does not implement yet, and the docs say so.
 */
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "bta.h"
#include "bta_notification_win32.h"

#include <windows.h>
#include <roapi.h>
#include <hstring.h>
#include <winstring.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <propvarutil.h>
#include <wchar.h>

#include <windows.ui.notifications.h>
#include <windows.data.xml.dom.h>

#include <string.h>

/* The generated headers name their types after the ABI; short aliases keep
 * the calls readable. */
typedef __x_ABI_CWindows_CUI_CNotifications_CIToastNotificationManagerStatics Manager;
typedef __x_ABI_CWindows_CUI_CNotifications_CIToastNotifier                Notifier;
typedef __x_ABI_CWindows_CUI_CNotifications_CIToastNotificationFactory     ToastFactory;
typedef __x_ABI_CWindows_CUI_CNotifications_CIToastNotification            Toast;
typedef __x_ABI_CWindows_CUI_CNotifications_CIToastActivatedEventArgs      ActivatedArgs;
typedef __x_ABI_CWindows_CData_CXml_CDom_CIXmlDocument                     XmlDocument;
typedef __x_ABI_CWindows_CData_CXml_CDom_CIXmlDocumentIO                   XmlDocumentIO;
typedef __FITypedEventHandler_2_Windows__CUI__CNotifications__CToastNotification_IInspectable ActivatedHandler;

/* The two GUIDs the shell's own headers leave to `uuid.lib`. */
static const CLSID clsid_shell_link = {
    0x00021401, 0x0000, 0x0000, { 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 }
};
static const IID iid_shell_link = {
    0x000214F9, 0x0000, 0x0000, { 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 }
};
static const IID iid_persist_file = {
    0x0000010B, 0x0000, 0x0000, { 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 }
};
static const IID iid_property_store = {
    0x886D8EEB, 0x8CF2, 0x4446, { 0x8D, 0x02, 0xCD, 0xBA, 0x1D, 0xBD, 0xCF, 0x99 }
};
static const IID iid_unknown = {
    0x00000000, 0x0000, 0x0000, { 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 }
};
static const IID iid_toast_manager = {
    0x50AC103F, 0xD235, 0x4598, { 0xBB, 0xEF, 0x98, 0xFE, 0x4D, 0x1A, 0x3A, 0xD4 }
};
static const IID iid_toast_factory = {
    0x04124B20, 0x82C6, 0x4229, { 0xB1, 0x09, 0xFD, 0x9E, 0xD4, 0x66, 0x2B, 0x53 }
};
static const IID iid_toast_activated_args = {
    0xE3BF92F3, 0xC197, 0x436F, { 0x82, 0x65, 0x06, 0x25, 0x82, 0x4F, 0x8D, 0xAC }
};
static const IID iid_xml_document = {
    0xF7F3A506, 0x1E87, 0x42D6, { 0xBC, 0xFB, 0xB8, 0xC8, 0x09, 0xFA, 0x54, 0x94 }
};
static const IID iid_xml_document_io = {
    0x6CD0E74E, 0xEE65, 0x4489, { 0x9E, 0xBF, 0xCA, 0x43, 0xE8, 0x7B, 0xA6, 0x37 }
};
static const IID iid_activated_handler = {
    0xAB54DE2D, 0x97D9, 0x5528, { 0xB6, 0xAD, 0x10, 0x5A, 0xFE, 0x15, 0x65, 0x30 }
};
static const PROPERTYKEY pkey_app_id = {
    { 0x9F4C2855, 0x9F79, 0x4B39, { 0xA8, 0xD0, 0xE1, 0xD4, 0x2D, 0xE1, 0xD5, 0xF3 } },
    5
};

typedef struct ToastEntry ToastEntry;

typedef struct {
    const __FITypedEventHandler_2_Windows__CUI__CNotifications__CToastNotification_IInspectableVtbl *lpVtbl;
    LONG       refs;
    ToastEntry *entry;
} ToastHandler;

struct ToastEntry {
    char       *id;
    Toast      *toast;
    ToastEntry *next;
};

static Manager      *manager;
static ToastFactory *toast_factory;
static Notifier     *notifier;
static ToastEntry   *entries;
static int           winrt_state = -1;   /* -1 untried, 0 no, 1 yes */

/* ----------------------------------------------------------- HSTRING/time */

static HSTRING win32_hstring(const char *utf8)
{
    gunichar2 *wide = g_utf8_to_utf16(utf8, -1, NULL, NULL, NULL);
    HSTRING    h    = NULL;

    if (wide) {
        WindowsCreateString((PCNZWCH)wide, (UINT32)wcslen((wchar_t *)wide), &h);
        g_free(wide);
    }
    return h;
}

static char *win32_utf8(HSTRING h)
{
    UINT32       len = 0;
    const wchar_t *raw;
    char        *utf8;

    if (!h)
        return NULL;
    raw = WindowsGetStringRawBuffer(h, &len);
    utf8 = g_utf16_to_utf8((const gunichar2 *)raw, (glong)len, NULL, NULL, NULL);
    return utf8;
}

/* ------------------------------------------------------------- the shortcut */

static bool ensure_shortcut(const char *aumid, const char *project_dir)
{
    char       *exe = bta_exe_path();
    char       *exe_dir = NULL;
    char       *gui = NULL;
    char       *start_menu = NULL;
    char       *safe = NULL;
    char       *lnk = NULL;
    char       *args = NULL;
    gunichar2  *gui_w = NULL, *dir_w = NULL, *lnk_w = NULL, *args_w = NULL, *aumid_w = NULL;
    IShellLinkW *link = NULL;
    IPropertyStore *store = NULL;
    IPersistFile *file = NULL;
    HRESULT     hr = S_OK;
    const char *why = "unknown";
    bool        ok = false;

    if (!exe) {
        why = "no executable path";
        goto done;
    }

    /* `bintanaw.exe` is the same runtime with a GUI header: a shortcut that
     * opens a console behind the window is not what a Start Menu entry is
     * for. */
    exe_dir = g_path_get_dirname(exe);
    gui = g_build_filename(exe_dir, "bintanaw.exe", NULL);
    if (!g_file_test(gui, G_FILE_TEST_EXISTS)) {
        g_free(gui);
        gui = g_strdup(exe);
    }

    const char *roaming = g_getenv("APPDATA");

    if (!roaming || !*roaming)
        roaming = g_get_user_data_dir();
    start_menu = g_build_filename(roaming, "Microsoft", "Windows",
                                  "Start Menu", "Programs", "Bintana", NULL);
    if (g_mkdir_with_parents(start_menu, 0755) != 0) {
        why = "mkdir Start Menu/Bintana";
        goto done;
    }

    safe = g_strdup(aumid);
    for (char *p = safe; *p; p++) {
        if (strchr("\\/:*?\"<>|", *p))
            *p = '_';
    }
    char *lnk_name = g_strdup_printf("%s.lnk", safe);

    lnk = g_build_filename(start_menu, lnk_name, NULL);
    g_free(lnk_name);
    args = g_strdup_printf("\"%s\"", project_dir ? project_dir : "");

    gui_w   = g_utf8_to_utf16(gui, -1, NULL, NULL, NULL);
    dir_w   = g_utf8_to_utf16(project_dir ? project_dir : "", -1, NULL, NULL, NULL);
    lnk_w   = g_utf8_to_utf16(lnk, -1, NULL, NULL, NULL);
    args_w  = g_utf8_to_utf16(args, -1, NULL, NULL, NULL);
    aumid_w = g_utf8_to_utf16(aumid, -1, NULL, NULL, NULL);
    if (!gui_w || !dir_w || !lnk_w || !args_w || !aumid_w) {
        why = "UTF-16 conversion";
        goto done;
    }

    hr = CoCreateInstance(&clsid_shell_link, NULL, CLSCTX_INPROC_SERVER,
                          &iid_shell_link, (void **)&link);
    if (FAILED(hr)) {
        why = "CoCreateInstance(ShellLink)";
        goto done;
    }

    link->lpVtbl->SetPath(link, (LPCWSTR)gui_w);
    link->lpVtbl->SetArguments(link, (LPCWSTR)args_w);
    link->lpVtbl->SetWorkingDirectory(link, (LPCWSTR)dir_w);
    link->lpVtbl->SetDescription(link, L"Bintana application");
    link->lpVtbl->SetIconLocation(link, (LPCWSTR)gui_w, 0);

    hr = link->lpVtbl->QueryInterface(link, &iid_property_store,
                                      (void **)&store);
    if (FAILED(hr)) {
        why = "QueryInterface(IPropertyStore)";
        goto done;
    }

    PROPVARIANT pv = { 0 };
    size_t      bytes = (wcslen((wchar_t *)aumid_w) + 1) * sizeof(WCHAR);

    pv.vt      = VT_LPWSTR;
    pv.pwszVal = CoTaskMemAlloc(bytes);
    if (!pv.pwszVal) {
        why = "CoTaskMemAlloc";
        goto done;
    }
    memcpy(pv.pwszVal, aumid_w, bytes);
    hr = store->lpVtbl->SetValue(store, &pkey_app_id, &pv);
    PropVariantClear(&pv);
    if (FAILED(hr)) {
        why = "IPropertyStore::SetValue";
        goto done;
    }
    store->lpVtbl->Commit(store);

    hr = link->lpVtbl->QueryInterface(link, &iid_persist_file,
                                      (void **)&file);
    if (FAILED(hr)) {
        why = "QueryInterface(IPersistFile)";
        goto done;
    }
    hr = file->lpVtbl->Save(file, (LPCOLESTR)lnk_w, TRUE);
    if (FAILED(hr)) {
        why = "IPersistFile::Save";
        goto done;
    }

    ok = true;

done:
    if (!ok)
        g_message("notification-win32: shortcut failed: %s (hr=0x%08lx, path=%s)",
                  why, (unsigned long)hr, lnk ? lnk : "(none)");
    if (file)
        file->lpVtbl->Release(file);
    if (store)
        store->lpVtbl->Release(store);
    if (link)
        link->lpVtbl->Release(link);
    g_free(gui_w);
    g_free(dir_w);
    g_free(lnk_w);
    g_free(args_w);
    g_free(aumid_w);
    g_free(args);
    g_free(lnk);
    g_free(safe);
    g_free(start_menu);
    g_free(gui);
    g_free(exe_dir);
    g_free(exe);
    return ok;
}

/* ---------------------------------------------------------------- WinRT */

static bool ensure_winrt(void)
{
    HSTRING cls;
    HRESULT hr;

    if (winrt_state >= 0)
        return winrt_state == 1;

    hr = CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        winrt_state = 0;
        return false;
    }
    hr = RoInitialize(RO_INIT_MULTITHREADED);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        winrt_state = 0;
        return false;
    }

    cls = win32_hstring("Windows.UI.Notifications.ToastNotificationManager");
    if (!cls) {
        winrt_state = 0;
        return false;
    }
    hr = RoGetActivationFactory(
        cls, &iid_toast_manager, (void **)&manager);
    WindowsDeleteString(cls);
    winrt_state = SUCCEEDED(hr) ? 1 : 0;
    return winrt_state == 1;
}

static bool ensure_notifier(const char *aumid)
{
    HSTRING h;

    if (notifier)
        return true;
    if (!ensure_winrt())
        return false;
    h = win32_hstring(aumid);
    if (!h)
        return false;
    HRESULT hr = manager->lpVtbl->CreateToastNotifierWithId(manager, h, &notifier);
    WindowsDeleteString(h);
    return SUCCEEDED(hr);
}

static bool ensure_factory(void)
{
    HSTRING cls;
    HRESULT hr;

    if (toast_factory)
        return true;
    cls = win32_hstring("Windows.UI.Notifications.ToastNotification");
    if (!cls)
        return false;
    hr = RoGetActivationFactory(
        cls, &iid_toast_factory, (void **)&toast_factory);
    WindowsDeleteString(cls);
    return SUCCEEDED(hr);
}

/* ------------------------------------------------------------- the XML */

static char *toast_xml(const char *title, const char *body, const char *urgency,
                       const BtaNotificationButton *buttons, int n_buttons)
{
    GString *xml = g_string_new("<toast");
    char    *esc;

    if (urgency && g_ascii_strcasecmp(urgency, "Urgent") == 0)
        g_string_append(xml, " scenario=\"reminder\"");
    else if (urgency && g_ascii_strcasecmp(urgency, "High") == 0)
        g_string_append(xml, " duration=\"long\"");

    g_string_append(xml, "><visual><binding template=\"ToastGeneric\">");
    esc = g_markup_escape_text(title ? title : "", -1);
    g_string_append_printf(xml, "<text>%s</text>", esc);
    g_free(esc);
    if (body && *body) {
        esc = g_markup_escape_text(body, -1);
        g_string_append_printf(xml, "<text>%s</text>", esc);
        g_free(esc);
    }
    g_string_append(xml, "</binding></visual>");

    if (n_buttons > 0) {
        g_string_append(xml, "<actions>");
        for (int i = 0; i < n_buttons; i++) {
            char *label  = g_markup_escape_text(buttons[i].label ? buttons[i].label : "", -1);
            char *action = g_markup_escape_text(buttons[i].action ? buttons[i].action : "", -1);

            g_string_append_printf(
                xml, "<action content=\"%s\" arguments=\"%s\" activationType=\"foreground\"/>",
                label, action);
            g_free(label);
            g_free(action);
        }
        g_string_append(xml, "</actions>");
    }
    g_string_append(xml, "</toast>");
    return g_string_free(xml, FALSE);
}

static XmlDocument *make_xml(const char *xml_text)
{
    HSTRING        cls, xml;
    IInspectable  *instance = NULL;
    XmlDocumentIO *io = NULL;
    XmlDocument   *document = NULL;
    HRESULT        hr;

    cls = win32_hstring("Windows.Data.Xml.Dom.XmlDocument");
    if (!cls)
        return NULL;
    hr = RoActivateInstance(cls, &instance);
    WindowsDeleteString(cls);
    if (FAILED(hr))
        return NULL;

    hr = instance->lpVtbl->QueryInterface(
        instance, &iid_xml_document_io, (void **)&io);
    if (FAILED(hr))
        goto done;
    hr = instance->lpVtbl->QueryInterface(
        instance, &iid_xml_document, (void **)&document);
    if (FAILED(hr))
        goto done;

    xml = win32_hstring(xml_text);
    if (!xml)
        goto done;
    hr = io->lpVtbl->LoadXml(io, xml);
    WindowsDeleteString(xml);
    if (FAILED(hr)) {
        document->lpVtbl->Release(document);
        document = NULL;
    }

done:
    if (io)
        io->lpVtbl->Release(io);
    if (instance)
        instance->lpVtbl->Release(instance);
    return document;
}

/* ------------------------------------------------------ the event handler */

static gboolean activate_idle(gpointer data)
{
    char **pair = data;

    bta_notification_activate(pair[0], pair[1] && *pair[1] ? pair[1] : NULL);
    g_free(pair[0]);
    g_free(pair[1]);
    g_free(pair);
    return G_SOURCE_REMOVE;
}

static HRESULT STDMETHODCALLTYPE handler_QueryInterface(ActivatedHandler *This,
                                                        REFIID riid,
                                                        void **ppvObject)
{
    if (!ppvObject)
        return E_POINTER;
    if (IsEqualIID(riid, &iid_unknown) ||
        IsEqualIID(riid, &iid_activated_handler)) {
        *ppvObject = This;
        This->lpVtbl->AddRef(This);
        return S_OK;
    }
    *ppvObject = NULL;
    return E_NOINTERFACE;
}

static ULONG STDMETHODCALLTYPE handler_AddRef(ActivatedHandler *This)
{
    ToastHandler *h = (ToastHandler *)This;

    return (ULONG)InterlockedIncrement((volatile LONG *)&h->refs);
}

static ULONG STDMETHODCALLTYPE handler_Release(ActivatedHandler *This)
{
    ToastHandler *h = (ToastHandler *)This;
    LONG          refs = InterlockedDecrement((volatile LONG *)&h->refs);

    if (refs == 0)
        g_free(h);
    return (ULONG)refs;
}

static HRESULT STDMETHODCALLTYPE handler_Invoke(ActivatedHandler *This,
                                                __x_ABI_CWindows_CUI_CNotifications_CIToastNotification *sender,
                                                IInspectable *args)
{
    ToastHandler   *h = (ToastHandler *)This;
    ActivatedArgs  *activated = NULL;
    HSTRING         arguments = NULL;
    char           *action = NULL;

    (void)sender;
    if (!h->entry || !args)
        return S_OK;
    if (FAILED(args->lpVtbl->QueryInterface(
            args, &iid_toast_activated_args, (void **)&activated)))
        return S_OK;

    if (SUCCEEDED(activated->lpVtbl->get_Arguments(activated, &arguments)))
        action = win32_utf8(arguments);
    if (arguments)
        WindowsDeleteString(arguments);
    activated->lpVtbl->Release(activated);

    char **pair = g_new0(char *, 2);

    pair[0] = g_strdup(h->entry->id);
    pair[1] = action;
    g_main_context_invoke(NULL, activate_idle, pair);
    return S_OK;
}

static const __FITypedEventHandler_2_Windows__CUI__CNotifications__CToastNotification_IInspectableVtbl handler_vtbl = {
    handler_QueryInterface,
    handler_AddRef,
    handler_Release,
    handler_Invoke,
};

/* ------------------------------------------------------------- the public */

bool bta_notification_win32_available(void)
{
    return ensure_winrt();
}

int bta_notification_win32_max_buttons(void)
{
    return 3;
}

bool bta_notification_win32_send(JSContext *ctx, const char *aumid,
                                 const char *id, const char *title,
                                 const char *body, const char *urgency,
                                 const BtaNotificationButton *buttons,
                                 int n_buttons, const char *project_dir)
{
    char       *xml_text;
    XmlDocument *document;
    Toast      *toast = NULL;
    ToastEntry *entry;
    ToastHandler *handler;
    EventRegistrationToken token;
    HRESULT     hr;
    bool        ok = false;

    if (!aumid || !*aumid || !id || !*id)
        return false;
    if (!ensure_winrt()) {
        g_message("notification-win32: WinRT is not available");
        return false;
    }
    if (!ensure_shortcut(aumid, project_dir))
        return false;
    if (!ensure_notifier(aumid)) {
        g_message("notification-win32: CreateToastNotifierWithId failed for %s", aumid);
        return false;
    }
    if (!ensure_factory()) {
        g_message("notification-win32: ToastNotification factory failed");
        return false;
    }

    xml_text = toast_xml(title, body, urgency, buttons, n_buttons);
    document = make_xml(xml_text);
    g_free(xml_text);
    if (!document) {
        g_message("notification-win32: XmlDocument failed");
        return false;
    }

    hr = toast_factory->lpVtbl->CreateToastNotification(toast_factory, document,
                                                        &toast);
    document->lpVtbl->Release(document);
    if (FAILED(hr)) {
        g_message("notification-win32: CreateToastNotification failed (hr=0x%08lx)",
                  (unsigned long)hr);
        return false;
    }

    entry = g_new0(ToastEntry, 1);
    entry->id    = g_strdup(id);
    entry->toast = toast;
    entry->next  = entries;
    entries = entry;

    handler = g_new0(ToastHandler, 1);
    handler->lpVtbl = &handler_vtbl;
    handler->refs  = 1;
    handler->entry = entry;

    hr = toast->lpVtbl->add_Activated(toast, (ActivatedHandler *)handler, &token);
    handler->lpVtbl->Release((ActivatedHandler *)handler);   /* the toast holds one */
    if (FAILED(hr))
        goto done;

    if (FAILED(notifier->lpVtbl->Show(notifier, toast)))
        goto done;

    ok = true;

done:
    if (!ok) {
        /* A failed show leaves the entry alive only until cleanup; hide it and
         * let the normal sweep release it. */
        notifier->lpVtbl->Hide(notifier, toast);
    }
    (void)ctx;
    return ok;
}

void bta_notification_win32_withdraw(const char *id)
{
    if (!notifier || !id)
        return;
    for (ToastEntry *e = entries; e; e = e->next) {
        if (strcmp(e->id, id) == 0) {
            notifier->lpVtbl->Hide(notifier, e->toast);
            return;
        }
    }
}

void bta_notification_win32_cleanup(void)
{
    if (notifier) {
        for (ToastEntry *e = entries; e; e = e->next)
            notifier->lpVtbl->Hide(notifier, e->toast);
    }
    while (entries) {
        ToastEntry *next = entries->next;

        if (entries->toast)
            entries->toast->lpVtbl->Release(entries->toast);
        g_free(entries->id);
        g_free(entries);
        entries = next;
    }
    if (notifier) {
        notifier->lpVtbl->Release(notifier);
        notifier = NULL;
    }
    if (toast_factory) {
        toast_factory->lpVtbl->Release(toast_factory);
        toast_factory = NULL;
    }
    if (manager) {
        manager->lpVtbl->Release(manager);
        manager = NULL;
    }
}
