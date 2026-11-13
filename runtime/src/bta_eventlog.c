/*
 * The Windows Event Log, as an extension to logging and not as part of it.
 *
 * The runtime's own logging is stdout and stderr, which every system has.
 * `bta_journal.c` is the systemd backend and this is the Windows one: the same
 * name and the same two questions, answered by whichever is built.
 *
 * **Writing works without a registry entry; being readable does not.**  The
 * Event Log service accepts an event whose source it has never heard of -- it
 * records the provider name and the data, which is what a `Logger` line is --
 * but with no `EventMessageFile` the viewer has no message table to look the
 * event id up in, so it shows the data and says the description cannot be
 * found.  `bintana --register-event-source` is the one elevated step: it adds
 * the source under HKLM and names this executable, whose message table comes
 * from `runtime/src/bintana-events.mc`.  After it, the same lines read as
 * sentences in the Application log.
 *
 * Levels map onto the three event types the Application log carries; the event
 * IDs are the four messages in the table.
 */
#include "bta.h"

#ifdef G_OS_WIN32

#include <windows.h>

#define BTA_EVENT_SOURCE L"Bintana"
#define BTA_EVENT_DEBUG_ID   0x1000
#define BTA_EVENT_INFO_ID    0x1001
#define BTA_EVENT_WARNING_ID 0x1002
#define BTA_EVENT_ERROR_ID   0x1003

static HANDLE source_handle;
static gsize  source_once;
static char   source_why[256];

static bool event_source_open(void)
{
    if (g_once_init_enter(&source_once)) {
        source_handle = RegisterEventSourceW(NULL, BTA_EVENT_SOURCE);
        if (!source_handle) {
            DWORD code = GetLastError();

            /* A Windows error message is translated, and the reason a person
             * needs here is the command that fixes it. */
            if (code == ERROR_ACCESS_DENIED)
                g_strlcpy(source_why,
                          "the Event Log refused the Bintana source; run "
                          "`bintana --register-event-source` from an elevated "
                          "prompt", sizeof source_why);
            else
                g_snprintf(source_why, sizeof source_why,
                           "cannot open the Bintana event source (Windows "
                           "error %lu)", (unsigned long)code);
        }
        g_once_init_leave(&source_once, 1);
    }
    return source_handle != NULL;
}

const char *bta_platform_log_name(void)
{
    return "EventLog";
}

bool bta_platform_log_available(void)
{
    return event_source_open();
}

const char *bta_platform_log_why(void)
{
    event_source_open();
    return source_why;
}

bool bta_platform_log_send(int level, const char *text)
{
    WORD  type;
    DWORD id;

    if (!event_source_open())
        return false;

    switch (level) {
    case 0:  type = EVENTLOG_INFORMATION_TYPE; id = BTA_EVENT_DEBUG_ID;   break;
    case 2:  type = EVENTLOG_WARNING_TYPE;     id = BTA_EVENT_WARNING_ID; break;
    case 3:  type = EVENTLOG_ERROR_TYPE;       id = BTA_EVENT_ERROR_ID;   break;
    default: type = EVENTLOG_INFORMATION_TYPE; id = BTA_EVENT_INFO_ID;    break;
    }

    wchar_t *wide = g_utf8_to_utf16(text, -1, NULL, NULL, NULL);

    if (!wide)
        return false;

    LPCWSTR strings[1] = { wide };
    BOOL    ok = ReportEventW(source_handle, type, 0, id, NULL, 1, 0,
                              strings, NULL);

    g_free(wide);
    return ok != 0;
}

/*
 * The one elevated step: HKLM is the Event Log's own database and there is no
 * per-user spelling of it.  `Application` is the log a person finds under
 * *Windows Logs*; the message file is this executable, which carries the table
 * from `bintana-events.mc`.  Without it events are still recorded -- the
 * service accepts an unregistered source -- but the viewer cannot describe
 * them.
 */
bool bta_eventlog_register(void)
{
    const wchar_t *key_name =
        L"SYSTEM\\CurrentControlSet\\Services\\EventLog\\Application\\Bintana";
    wchar_t *exe = g_malloc(32768 * sizeof(wchar_t));
    DWORD    n   = GetModuleFileNameW(NULL, exe, 32768);
    HKEY     key = NULL;
    LONG     rc;
    bool     ok  = false;

    if (n == 0 || n >= 32768) {
        g_snprintf(source_why, sizeof source_why,
                   "cannot find this executable's path (Windows error %lu)",
                   (unsigned long)GetLastError());
        g_free(exe);
        return false;
    }

    rc = RegCreateKeyExW(HKEY_LOCAL_MACHINE, key_name, 0, NULL,
                         REG_OPTION_NON_VOLATILE, KEY_WRITE, NULL, &key, NULL);
    if (rc != ERROR_SUCCESS) {
        if (rc == ERROR_ACCESS_DENIED)
            g_strlcpy(source_why,
                      "an administrator is required; run `bintana "
                      "--register-event-source` from an elevated prompt",
                      sizeof source_why);
        else
            g_snprintf(source_why, sizeof source_why,
                       "cannot open the Bintana event source key (Windows "
                       "error %ld)", (long)rc);
        g_free(exe);
        return false;
    }

    DWORD bytes = (DWORD)((wcslen(exe) + 1) * sizeof(wchar_t));
    DWORD types = EVENTLOG_ERROR_TYPE | EVENTLOG_WARNING_TYPE |
                  EVENTLOG_INFORMATION_TYPE;

    if (RegSetValueExW(key, L"EventMessageFile", 0, REG_SZ,
                       (const BYTE *)exe, bytes) != ERROR_SUCCESS ||
        RegSetValueExW(key, L"TypesSupported", 0, REG_DWORD,
                       (const BYTE *)&types, sizeof types) != ERROR_SUCCESS) {
        g_snprintf(source_why, sizeof source_why,
                   "cannot write the Bintana event source (Windows error %lu)",
                   (unsigned long)GetLastError());
    } else {
        source_why[0] = '\0';
        ok = true;
    }

    RegCloseKey(key);
    g_free(exe);
    return ok;
}

#endif /* G_OS_WIN32 */
