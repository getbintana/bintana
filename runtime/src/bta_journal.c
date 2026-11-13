/*
 * The systemd journal, as an extension to logging and not as part of it.
 *
 * The runtime's own logging is stdout and stderr, which every system has.  A
 * platform that offers something better plugs in here: this file is the systemd
 * one, and `bta_eventlog.c` is the Windows one -- the same name and the same
 * two questions, answered by whichever is built.
 *
 * Optional at build time.  Without libsystemd the stubs below compile, the
 * runtime still logs to the terminal, and asking for a journal that is not
 * there says so rather than logging nowhere.
 */
#include "bta.h"

#ifdef BTA_HAVE_JOURNAL

#include <systemd/sd-journal.h>

const char *bta_platform_log_name(void)
{
    return "Journal";
}

bool bta_platform_log_available(void)
{
    return true;
}

const char *bta_platform_log_why(void)
{
    return "";
}

bool bta_platform_log_send(int level, const char *text)
{
    /*
     * A level is a syslog priority with another name, which is the whole reason
     * the journal is a good fit: Debug, Info, Warning, Error map straight onto
     * LOG_DEBUG, LOG_INFO, LOG_WARNING, LOG_ERR.
     */
    static const int priority[] = { 7, 6, 4, 3 };

    if (level < 0 || level >= (int)(sizeof(priority) / sizeof(priority[0])))
        return false;

    return sd_journal_send("MESSAGE=%s", text,
                           "PRIORITY=%i", priority[level],
                           NULL) == 0;
}

#else   /* built without libsystemd, or not on a systemd system */

const char *bta_platform_log_name(void)
{
    return "Journal";
}

bool bta_platform_log_available(void)
{
    return false;
}

const char *bta_platform_log_why(void)
{
    return "this build has no journal";
}

bool bta_platform_log_send(int level, const char *text)
{
    (void)level;
    (void)text;
    return false;
}

#endif
