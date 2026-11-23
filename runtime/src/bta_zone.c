/*
 * Zone -- the IANA time zones: what the clock reads in a place at an instant.
 *
 * `Day` is a date with no zone and `Time` a time of day with no zone; an
 * instant -- a `Date` -- has neither until a zone is chosen. `Zone` is that
 * bridge, and nothing else: offsets, abbreviations, the next time the clocks
 * move, and an instant turned into the `Day` and `Time` a place reads. Where
 * the sun is, and how a date is written, are not a zone's business (`Locale`
 * writes `Zone.Day(...)` like any other date).
 *
 * ## Why the runtime reads the data itself
 *
 * QuickJS has no `Intl`, so `toLocaleString({ timeZone })` is silently the
 * local zone. GLib has `GTimeZone`, and on Windows it is no help: its TZif
 * reader is compiled under `G_OS_UNIX` only, `TZDIR` is never read there, and
 * an IANA id answers NULL -- measured with GLib 2.90.1 on Windows 11, which
 * accepted only the registry's own names ("Tokyo Standard Time"), with the
 * abbreviation translated into the desktop's language. Windows' own `icu.dll`
 * knows the IANA ids but ships tzdata 2022g and is not updated by Windows
 * Update: Cairo, Almaty, Asunción and Nuuk read wrong today through it.
 *
 * So the data is the TZif files of the IANA database (RFC 8536), read by a
 * reader of our own -- the same one on every platform, so an abbreviation or a
 * transition is the same answer everywhere. The reader is JavaScript, in
 * rad.js, beside the rest of `Zone`; it was checked against Python's zoneinfo
 * and `zdump` over every zone in zone.tab and zone1970.tab, 1850-2099, the
 * second before and the second of every transition, in the fat and the slim
 * TZif forms, with no difference.
 *
 * What is here is what JavaScript cannot ask: where the data is, which zone
 * this machine is set to, and which release of the database it is.
 */
#include "bta.h"

#include <string.h>

#ifdef G_OS_WIN32
#include <windows.h>
#endif

/*
 * An IANA id as this runtime accepts one: `Area/Location[/Sub]` out of
 * letters, digits, `_`, `-` and `+`, plus `UTC`-style single words.
 *
 * It is also a path inside the data directory, so the check is what keeps
 * `../../etc/passwd` from being read as a zone: no leading `/`, no empty
 * component, no `.` anywhere. rad.js applies the same rule (`idOk` in
 * `zoneReader`) to the ids a program passes; this one guards what the
 * machine says.
 */
static bool zone_id_ok(const char *id)
{
    if (!id || !*id || strlen(id) > 255 || id[0] == '/')
        return false;

    for (const char *p = id; *p; p++) {
        char c = *p;

        if (c == '/' && (p[1] == '/' || p[1] == '\0'))
            return false;
        if (!(g_ascii_isalnum(c) || c == '/' || c == '_' || c == '-' || c == '+'))
            return false;
    }
    return true;
}

/* A directory that holds a TZif database: `UTC` is in every build of it,
 * slim or fat, with or without the `posix/` and `right/` copies. */
static bool zone_dir_ok(const char *dir)
{
    if (!dir || !*dir)
        return false;

    char *utc = g_build_filename(dir, "UTC", NULL);
    bool  ok  = g_file_test(utc, G_FILE_TEST_IS_REGULAR);

    g_free(utc);
    return ok;
}

/* `<prefix>/share/zoneinfo`, the prefix being the directory above the one the
 * binary is in -- where the Windows tree carries the database, and where any
 * relocatable tree may. */
static char *zone_dir_bundled(void)
{
    char *exe = bta_exe_path();
    if (!exe)
        return NULL;

    char *bin = g_path_get_dirname(exe);
    char *up  = g_path_get_dirname(bin);
    char *dir = g_build_filename(up, "share", "zoneinfo", NULL);

    g_free(up);
    g_free(bin);
    g_free(exe);
    if (zone_dir_ok(dir))
        return dir;
    g_free(dir);
    return NULL;
}

/*
 * Where the database is read from, or NULL.
 *
 * `TZDIR` first: it is the variable the C library and zdump honour, and it is
 * how a test or a user points at another release. Then **the system's copy
 * before ours** everywhere but Windows, because the distribution updates it
 * -- IANA publishes several releases a year, and a country that changes its
 * clocks with a month's notice is fixed by the next `dnf upgrade`, not by the
 * next Bintana. Windows has no system copy, so there ours comes first. The
 * system paths are the ones Python's zoneinfo searches, for the same machines.
 */
static char *zone_directory(void)
{
    const char *env = g_getenv("TZDIR");
    if (zone_dir_ok(env))
        return g_strdup(env);

#ifdef G_OS_WIN32
    char *bundled = zone_dir_bundled();
    if (bundled)
        return bundled;
#else
    static const char * const SYSTEM[] = {
        "/usr/share/zoneinfo", "/usr/lib/zoneinfo",
        "/usr/share/lib/zoneinfo", "/etc/zoneinfo",
    };

    for (size_t i = 0; i < G_N_ELEMENTS(SYSTEM); i++)
        if (zone_dir_ok(SYSTEM[i]))
            return g_strdup(SYSTEM[i]);

    char *bundled = zone_dir_bundled();
    if (bundled)
        return bundled;
#endif

    /*
     * Last, `<data dir>/zoneinfo` for each of GLib's system data directories:
     * `XDG_DATA_DIRS` on Linux (a Flatpak's `/app/share` among them), and on
     * Windows the `share` beside GLib's own DLL -- which is what finds MSYS2's
     * `mingw-w64-ucrt-x86_64-tzdata` for a `build\bintana.exe` run from a
     * development tree, where nothing has been copied beside the binary.
     */
    const char * const *data = g_get_system_data_dirs();
    for (int i = 0; data && data[i]; i++) {
        char *dir = g_build_filename(data[i], "zoneinfo", NULL);
        if (zone_dir_ok(dir))
            return dir;
        g_free(dir);
    }
    return NULL;
}

/* Whether `id` names a file in the database -- the last word on an id the
 * machine reported, since a symlink or a registry can name what is not there. */
static bool zone_known(const char *dir, const char *id)
{
    if (!dir || !zone_id_ok(id))
        return false;

    char *path = g_build_filename(dir, id, NULL);
    bool  ok   = g_file_test(path, G_FILE_TEST_IS_REGULAR);

    g_free(path);
    return ok;
}

/*
 * What follows the last `zoneinfo/` in a path, without the `posix/` or
 * `right/` subtree a distribution may link through -- `/etc/localtime` is
 * `../usr/share/zoneinfo/America/Argentina/Buenos_Aires` on Fedora and
 * `/var/db/timezone/zoneinfo/Europe/Madrid` on macOS. NULL when the path does
 * not go through a zoneinfo directory at all.
 */
static char *zone_from_path(const char *path)
{
    /* Windows writes the same path with backslashes, and no id has one. */
    char       *norm = g_strdelimit(g_strdup(path), "\\", '/');
    const char *at   = NULL;

    for (const char *p = norm; (p = strstr(p, "zoneinfo/")); p++)
        at = p + strlen("zoneinfo/");
    if (!at) {
        g_free(norm);
        return NULL;
    }
    if (g_str_has_prefix(at, "posix/"))
        at += strlen("posix/");
    else if (g_str_has_prefix(at, "right/"))
        at += strlen("right/");

    char *out = g_strdup(at);
    g_free(norm);
    return out;
}

#ifdef G_OS_WIN32
/*
 * The registry's names for the zones, to IANA ids: CLDR's windowsZones.xml,
 * the rows for territory "001" (each Windows zone's principal place), with
 * the seven that CLDR spells with a retired id (`America/Buenos_Aires`,
 * `Asia/Calcutta` ...) followed through tzdata's links to the id the
 * database names today -- except Greenwich Standard Time, which stays
 * CLDR's `Atlantic/Reykjavik`: a link now, but Iceland's own row in zone.tab.
 * From CLDR main, 2026-11-22: 142 rows, then the two the registry still has
 * that CLDR dropped. A Windows 11 26H2 registry has 144 keys; all are here.
 *
 * The data is Unicode's: Copyright (c) 1991-2026 Unicode, Inc., distributed
 * under the Unicode License v3 (https://www.unicode.org/license.txt); see
 * THIRD-PARTY-NOTICES.md.
 *
 * Windows reports `TimeZoneKeyName`, which is the registry key and not a
 * translated label, so the lookup is exact.
 */
static const struct {
    const char *windows;
    const char *iana;
} WINDOWS_ZONES[] = {
    { "AUS Central Standard Time", "Australia/Darwin" },
    { "AUS Eastern Standard Time", "Australia/Sydney" },
    { "Afghanistan Standard Time", "Asia/Kabul" },
    { "Alaskan Standard Time", "America/Anchorage" },
    { "Alberta Standard Time", "America/Edmonton" },
    { "Aleutian Standard Time", "America/Adak" },
    { "Altai Standard Time", "Asia/Barnaul" },
    { "Arab Standard Time", "Asia/Riyadh" },
    { "Arabian Standard Time", "Asia/Dubai" },
    { "Arabic Standard Time", "Asia/Baghdad" },
    { "Argentina Standard Time", "America/Argentina/Buenos_Aires" },
    { "Astrakhan Standard Time", "Europe/Astrakhan" },
    { "Atlantic Standard Time", "America/Halifax" },
    { "Aus Central W. Standard Time", "Australia/Eucla" },
    { "Azerbaijan Standard Time", "Asia/Baku" },
    { "Azores Standard Time", "Atlantic/Azores" },
    { "Bahia Standard Time", "America/Bahia" },
    { "Bangladesh Standard Time", "Asia/Dhaka" },
    { "Belarus Standard Time", "Europe/Minsk" },
    { "Bougainville Standard Time", "Pacific/Bougainville" },
    { "British Columbia Standard Time", "America/Vancouver" },
    { "Canada Central Standard Time", "America/Regina" },
    { "Cape Verde Standard Time", "Atlantic/Cape_Verde" },
    { "Caucasus Standard Time", "Asia/Yerevan" },
    { "Cen. Australia Standard Time", "Australia/Adelaide" },
    { "Central America Standard Time", "America/Guatemala" },
    { "Central Asia Standard Time", "Asia/Bishkek" },
    { "Central Brazilian Standard Time", "America/Cuiaba" },
    { "Central Europe Standard Time", "Europe/Budapest" },
    { "Central European Standard Time", "Europe/Warsaw" },
    { "Central Pacific Standard Time", "Pacific/Guadalcanal" },
    { "Central Standard Time", "America/Chicago" },
    { "Central Standard Time (Mexico)", "America/Mexico_City" },
    { "Chatham Islands Standard Time", "Pacific/Chatham" },
    { "China Standard Time", "Asia/Shanghai" },
    { "Cuba Standard Time", "America/Havana" },
    { "Dateline Standard Time", "Etc/GMT+12" },
    { "E. Africa Standard Time", "Africa/Nairobi" },
    { "E. Australia Standard Time", "Australia/Brisbane" },
    { "E. Europe Standard Time", "Europe/Chisinau" },
    { "E. South America Standard Time", "America/Sao_Paulo" },
    { "Easter Island Standard Time", "Pacific/Easter" },
    { "Eastern Standard Time", "America/New_York" },
    { "Eastern Standard Time (Mexico)", "America/Cancun" },
    { "Egypt Standard Time", "Africa/Cairo" },
    { "Ekaterinburg Standard Time", "Asia/Yekaterinburg" },
    { "FLE Standard Time", "Europe/Kyiv" },
    { "Fiji Standard Time", "Pacific/Fiji" },
    { "GMT Standard Time", "Europe/London" },
    { "GTB Standard Time", "Europe/Bucharest" },
    { "Georgian Standard Time", "Asia/Tbilisi" },
    { "Greenland Standard Time", "America/Nuuk" },
    { "Greenwich Standard Time", "Atlantic/Reykjavik" },
    { "Haiti Standard Time", "America/Port-au-Prince" },
    { "Hawaiian Standard Time", "Pacific/Honolulu" },
    { "India Standard Time", "Asia/Kolkata" },
    { "Iran Standard Time", "Asia/Tehran" },
    { "Israel Standard Time", "Asia/Jerusalem" },
    { "Jordan Standard Time", "Asia/Amman" },
    { "Kaliningrad Standard Time", "Europe/Kaliningrad" },
    { "Korea Standard Time", "Asia/Seoul" },
    { "Libya Standard Time", "Africa/Tripoli" },
    { "Line Islands Standard Time", "Pacific/Kiritimati" },
    { "Lord Howe Standard Time", "Australia/Lord_Howe" },
    { "Magadan Standard Time", "Asia/Magadan" },
    { "Magallanes Standard Time", "America/Punta_Arenas" },
    { "Manitoba Standard Time", "America/Winnipeg" },
    { "Marquesas Standard Time", "Pacific/Marquesas" },
    { "Mauritius Standard Time", "Indian/Mauritius" },
    { "Middle East Standard Time", "Asia/Beirut" },
    { "Montevideo Standard Time", "America/Montevideo" },
    { "Morocco Standard Time", "Africa/Casablanca" },
    { "Mountain Standard Time", "America/Denver" },
    { "Mountain Standard Time (Mexico)", "America/Mazatlan" },
    { "Myanmar Standard Time", "Asia/Yangon" },
    { "N. Central Asia Standard Time", "Asia/Novosibirsk" },
    { "Namibia Standard Time", "Africa/Windhoek" },
    { "Nepal Standard Time", "Asia/Kathmandu" },
    { "New Zealand Standard Time", "Pacific/Auckland" },
    { "Newfoundland Standard Time", "America/St_Johns" },
    { "Norfolk Standard Time", "Pacific/Norfolk" },
    { "North Asia East Standard Time", "Asia/Irkutsk" },
    { "North Asia Standard Time", "Asia/Krasnoyarsk" },
    { "North Korea Standard Time", "Asia/Pyongyang" },
    { "Omsk Standard Time", "Asia/Omsk" },
    { "Pacific SA Standard Time", "America/Santiago" },
    { "Pacific Standard Time", "America/Los_Angeles" },
    { "Pacific Standard Time (Mexico)", "America/Tijuana" },
    { "Pakistan Standard Time", "Asia/Karachi" },
    { "Paraguay Standard Time", "America/Asuncion" },
    { "Qyzylorda Standard Time", "Asia/Qyzylorda" },
    { "Romance Standard Time", "Europe/Paris" },
    { "Russia Time Zone 10", "Asia/Srednekolymsk" },
    { "Russia Time Zone 11", "Asia/Kamchatka" },
    { "Russia Time Zone 3", "Europe/Samara" },
    { "Russian Standard Time", "Europe/Moscow" },
    { "SA Eastern Standard Time", "America/Cayenne" },
    { "SA Pacific Standard Time", "America/Bogota" },
    { "SA Western Standard Time", "America/La_Paz" },
    { "SE Asia Standard Time", "Asia/Bangkok" },
    { "Saint Pierre Standard Time", "America/Miquelon" },
    { "Sakhalin Standard Time", "Asia/Sakhalin" },
    { "Samoa Standard Time", "Pacific/Apia" },
    { "Sao Tome Standard Time", "Africa/Sao_Tome" },
    { "Saratov Standard Time", "Europe/Saratov" },
    { "Singapore Standard Time", "Asia/Singapore" },
    { "South Africa Standard Time", "Africa/Johannesburg" },
    { "South Sudan Standard Time", "Africa/Juba" },
    { "Sri Lanka Standard Time", "Asia/Colombo" },
    { "Sudan Standard Time", "Africa/Khartoum" },
    { "Syria Standard Time", "Asia/Damascus" },
    { "Taipei Standard Time", "Asia/Taipei" },
    { "Tasmania Standard Time", "Australia/Hobart" },
    { "Tocantins Standard Time", "America/Araguaina" },
    { "Tokyo Standard Time", "Asia/Tokyo" },
    { "Tomsk Standard Time", "Asia/Tomsk" },
    { "Tonga Standard Time", "Pacific/Tongatapu" },
    { "Transbaikal Standard Time", "Asia/Chita" },
    { "Turkey Standard Time", "Europe/Istanbul" },
    { "Turks And Caicos Standard Time", "America/Grand_Turk" },
    { "US Eastern Standard Time", "America/Indiana/Indianapolis" },
    { "US Mountain Standard Time", "America/Phoenix" },
    { "UTC", "Etc/UTC" },
    { "UTC+12", "Etc/GMT-12" },
    { "UTC+13", "Etc/GMT-13" },
    { "UTC-02", "Etc/GMT+2" },
    { "UTC-08", "Etc/GMT+8" },
    { "UTC-09", "Etc/GMT+9" },
    { "UTC-11", "Etc/GMT+11" },
    { "Ulaanbaatar Standard Time", "Asia/Ulaanbaatar" },
    { "Venezuela Standard Time", "America/Caracas" },
    { "Vladivostok Standard Time", "Asia/Vladivostok" },
    { "Volgograd Standard Time", "Europe/Volgograd" },
    { "W. Australia Standard Time", "Australia/Perth" },
    { "W. Central Africa Standard Time", "Africa/Lagos" },
    { "W. Europe Standard Time", "Europe/Berlin" },
    { "W. Mongolia Standard Time", "Asia/Hovd" },
    { "West Asia Standard Time", "Asia/Tashkent" },
    { "West Bank Standard Time", "Asia/Hebron" },
    { "West Pacific Standard Time", "Pacific/Port_Moresby" },
    { "Yakutsk Standard Time", "Asia/Yakutsk" },
    { "Yukon Standard Time", "America/Whitehorse" },
    /* Not CLDR's: two keys Windows still offers, as "(old)", that CLDR
     * no longer lists. Mid-Atlantic is UTC-02 all year, as it was mapped. */
    { "Kamchatka Standard Time", "Asia/Kamchatka" },
    { "Mid-Atlantic Standard Time", "Etc/GMT+2" },
};

/* The registry key of the zone Windows is set to, as an IANA id, or NULL. */
static char *zone_local_windows(void)
{
    DYNAMIC_TIME_ZONE_INFORMATION info;

    if (GetDynamicTimeZoneInformation(&info) == TIME_ZONE_ID_INVALID)
        return NULL;

    char *key = g_utf16_to_utf8((const gunichar2 *)info.TimeZoneKeyName,
                                -1, NULL, NULL, NULL);
    if (!key)
        return NULL;

    char *found = NULL;
    for (size_t i = 0; i < G_N_ELEMENTS(WINDOWS_ZONES) && !found; i++)
        if (strcmp(key, WINDOWS_ZONES[i].windows) == 0)
            found = g_strdup(WINDOWS_ZONES[i].iana);
    g_free(key);
    return found;
}
#endif

/*
 * The zone this machine is set to, as an IANA id, or NULL.
 *
 * `TZ` first, on every platform, when it names a zone the database has:
 * it is what the C library obeys for this process, so a program started with
 * `TZ=Asia/Tokyo` is in Tokyo whatever the desktop says. A `TZ` that is a
 * POSIX rule (`EST5EDT,M3.2.0,M11.1.0`) names no place and is passed over.
 *
 * Then the platform's own record: `/etc/localtime`'s link on Linux and macOS
 * (with Debian's `/etc/timezone` beside it for a copied file), the registry
 * on Windows. Every answer is checked against the database before it is
 * given, so `Zone.At(Zone.Local, ...)` never refuses what `Local` said.
 */
static char *zone_local(const char *dir)
{
    const char *tz = g_getenv("TZ");
    if (tz && *tz) {
        const char *id = tz[0] == ':' ? tz + 1 : tz;
        char       *from_path = g_path_is_absolute(id) ? zone_from_path(id) : NULL;
        const char *candidate = from_path ? from_path : id;

        if (zone_known(dir, candidate)) {
            char *out = g_strdup(candidate);
            g_free(from_path);
            return out;
        }
        g_free(from_path);
    }

#ifdef G_OS_WIN32
    char *win = zone_local_windows();
    if (zone_known(dir, win))
        return win;
    g_free(win);
#else
    char *link = g_file_read_link("/etc/localtime", NULL);
    if (link) {
        char *id = zone_from_path(link);
        g_free(link);
        if (zone_known(dir, id))
            return id;
        g_free(id);
    }

    char *text = NULL;
    if (g_file_get_contents("/etc/timezone", &text, NULL, NULL)) {
        g_strstrip(text);
        if (zone_known(dir, text))
            return text;
    }
    g_free(text);
#endif
    return NULL;
}

static JSValue js_zone_get_directory(JSContext *ctx, JSValueConst this_val)
{
    char   *dir = zone_directory();
    JSValue out = JS_NewString(ctx, dir ? dir : "");

    g_free(dir);
    return out;
}

/* UTC when nothing says otherwise: a container with no /etc/localtime is in
 * UTC as far as its C library is concerned too. */
static JSValue js_zone_get_local(JSContext *ctx, JSValueConst this_val)
{
    char *dir = zone_directory();
    char *id  = zone_local(dir);
    JSValue out = JS_NewString(ctx, id ? id : "UTC");

    g_free(id);
    g_free(dir);
    return out;
}

static JSValue js_zone_get_version(JSContext *ctx, JSValueConst this_val)
{
    char *dir = zone_directory();
    char *found = NULL;

    if (dir) {
        char *zi = g_build_filename(dir, "tzdata.zi", NULL);
        char *text = NULL;

        /* "# version 2026f" is the first line zic's own input carries. */
        if (g_file_get_contents(zi, &text, NULL, NULL)) {
            char *nl = strchr(text, '\n');
            if (nl)
                *nl = '\0';
            if (g_str_has_prefix(text, "# version "))
                found = g_strstrip(g_strdup(text + strlen("# version ")));
        }
        g_free(text);
        text = NULL;
        g_free(zi);

        if (!found) {
            char *ver = g_build_filename(dir, "+VERSION", NULL);
            if (g_file_get_contents(ver, &text, NULL, NULL))
                found = g_strstrip(text);
            g_free(ver);
        }
    }

    JSValue out = JS_NewString(ctx, found ? found : "");
    g_free(found);
    g_free(dir);
    return out;
}

static const JSCFunctionListEntry zone_props[] = {
    /* Directory -> string
     *   where the time zone database is read from: `TZDIR` when it is set,
     *   then the system's (`/usr/share/zoneinfo`), then the copy beside the
     *   runtime (`share/zoneinfo`, which is what Windows has), then
     *   `zoneinfo` in the desktop's data directories. `""` when there is none,
     *   and then every member that reads a zone refuses
     */
    JS_CGETSET_DEF("Directory", js_zone_get_directory, NULL),
    /* Local -> string
     *   the zone this machine is set to, as an IANA id
     *   (`"America/Argentina/Buenos_Aires"`): `TZ` when it names a zone, else
     *   `/etc/localtime`, else on Windows the registry's zone through CLDR's
     *   table -- and `"UTC"` when the machine cannot say
     */
    JS_CGETSET_DEF("Local",     js_zone_get_local,     NULL),
    /* Version -> string
     *   which release of the IANA database is being read (`"2026f"`), from its
     *   `tzdata.zi` or `+VERSION`; `""` when the copy does not say
     */
    JS_CGETSET_DEF("Version",   js_zone_get_version,   NULL),
};

/* The rest of `Zone` -- List, Info, At, Next, Day, Time, Instant -- is
 * rad.js's, written onto this object. */
void bta_zone_init(JSContext *ctx, JSValue global)
{
    JSValue zone = JS_NewObject(ctx);

    JS_SetPropertyFunctionList(ctx, zone, zone_props, G_N_ELEMENTS(zone_props));
    JS_SetPropertyStr(ctx, global, "Zone", zone);
}
