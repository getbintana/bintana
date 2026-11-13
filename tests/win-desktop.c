/*
 * A private Windows desktop for the suite.
 *
 * Windows has no Xvfb, so the default `tests/run.sh` would open every test's
 * window over whatever the person at the machine is doing.  A desktop is the
 * platform's own answer: `CreateDesktopW` makes one, `STARTUPINFO.lpDesktop`
 * puts the child on it, and nothing it draws is visible on the default
 * desktop.  The child sees an ordinary session (`Environment.HasDisplay` is
 * true), which is what lets `tests/runner` use its normal path instead of
 * hunting for `xvfb-run`.
 *
 * Built by `tests/run.sh` with the MSYS2 compiler into `build/win-desktop.exe`;
 * `HEADLESS=` (empty) is the way back to the real desktop, exactly as on
 * Linux.  The helper itself opens no window.
 *
 * `tests/win-desktop.c` is a test tool, not part of the runtime: it is
 * compiled here and never installed.
 */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

/* One argument, quoted the way CommandLineToArgvW reads it back. */
static void append_quoted(wchar_t *out, const wchar_t *arg)
{
    const wchar_t *p = arg;
    int            quote = 0;

    for (const wchar_t *q = arg; *q; q++)
        if (*q == L' ' || *q == L'\t' || *q == L'"')
            quote = 1;
    if (quote)
        wcscat(out, L"\"");
    while (*p) {
        int backslashes = 0;

        while (*p == L'\\') {
            backslashes++;
            p++;
        }
        if (*p == L'"') {
            for (int i = 0; i < backslashes * 2 + 1; i++)
                wcscat(out, L"\\");
            wcscat(out, L"\"");
            p++;
        } else {
            for (int i = 0; i < backslashes; i++)
                wcscat(out, L"\\");
            if (*p) {
                wchar_t one[2] = { *p++, 0 };
                wcscat(out, one);
            }
        }
    }
    if (quote)
        wcscat(out, L"\"");
}

int wmain(int argc, wchar_t **argv)
{
    wchar_t desktop[64];
    wchar_t *cmd;
    size_t   size = 0;
    HDESK    desk;
    HANDLE   job = NULL;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    DWORD    code = 2;

    if (argc < 2) {
        fwprintf(stderr, L"usage: win-desktop <program> [args...]\n");
        return 2;
    }

    swprintf(desktop, 64, L"bta-suite-%lu", (unsigned long)GetCurrentProcessId());
    desk = CreateDesktopW(desktop, NULL, NULL, 0, GENERIC_ALL, NULL);
    if (!desk) {
        fwprintf(stderr, L"win-desktop: CreateDesktopW failed: %lu\n",
                 (unsigned long)GetLastError());
        return 2;
    }

    for (int i = 1; i < argc; i++)
        size += wcslen(argv[i]) * 2 + 4;
    cmd = malloc(size * sizeof(wchar_t));
    if (!cmd) {
        CloseDesktop(desk);
        return 2;
    }
    cmd[0] = 0;
    for (int i = 1; i < argc; i++) {
        if (i > 1)
            wcscat(cmd, L" ");
        append_quoted(cmd, argv[i]);
    }

    /*
     * The job is the crash guard: if this helper is killed, the job closes and
     * Windows ends the runner it started, so no test process is left on a
     * desktop nobody can see.  A machine that refuses nested jobs simply does
     * not get that guarantee; the runner's own guard still applies.
     */
    job = CreateJobObjectW(NULL, NULL);
    if (job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
        ZeroMemory(&limits, sizeof limits);
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                &limits, sizeof limits);
    }

    ZeroMemory(&si, sizeof si);
    si.cb        = sizeof si;
    si.lpDesktop = desktop;
    ZeroMemory(&pi, sizeof pi);

    if (!CreateProcessW(argv[1], cmd, NULL, NULL, TRUE, 0, NULL, NULL,
                        &si, &pi)) {
        fwprintf(stderr, L"win-desktop: CreateProcessW failed: %lu\n",
                 (unsigned long)GetLastError());
        free(cmd);
        if (job)
            CloseHandle(job);
        CloseDesktop(desk);
        return 2;
    }
    if (job)
        AssignProcessToJobObject(job, pi.hProcess);

    WaitForSingleObject(pi.hProcess, INFINITE);
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    if (job)
        CloseHandle(job);

    free(cmd);
    CloseDesktop(desk);
    return (int)code;
}
