/*
 * bintana-exec -- the Windows half of `Exec`.
 *
 * `Exec` means the same thing on every platform: the child gets pipes for its
 * standard streams, and no terminal.  On Windows a console program started by
 * a GUI program gets a console window of its own unless the caller passes
 * `CREATE_NO_WINDOW`, and GLib's GSubprocess does not expose that flag.  This
 * helper is the missing half: a GUI-subsystem program, so it has no console
 * itself, which starts the real command with `CREATE_NO_WINDOW` and the
 * handles GSubprocess gave it, then waits for it and returns its exit code.
 *
 * The job object is the child's process group.  `Stop`, `Kill` and a
 * `Exec.Wait` timeout end the helper; closing the last handle to the job then
 * ends the real child and anything it started, even if the helper itself was
 * terminated before it could wait.
 *
 * **Not part of the runtime link.**  It uses Windows and nothing else -- no
 * GLib, no GTK -- so it starts in a tree whose DLLs are broken, and it is
 * installed beside `bintana.exe` and `bintana-gui.exe`.
 */
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>
#include <io.h>
#include <shellapi.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* One argument, quoted the way CommandLineToArgvW reads it back.  The same
 * function `tests/win-desktop.c` uses; there is no GLib here to borrow one
 * from. */
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

static HANDLE standard_handle(int fd)
{
    intptr_t handle = _get_osfhandle(fd);

    if (handle == -1 || handle == -2)
        return GetStdHandle(fd == 0 ? STD_INPUT_HANDLE
                                    : fd == 1 ? STD_OUTPUT_HANDLE
                                              : STD_ERROR_HANDLE);
    return (HANDLE)handle;
}

static bool is_file(const wchar_t *path)
{
    DWORD attributes = GetFileAttributesW(path);

    return attributes != INVALID_FILE_ATTRIBUTES &&
           !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

/* **The command, resolved on the PATH the child was given.**  CreateProcessW
 * with a bare name searches System32 before PATH, so a `sort` that GSubprocess
 * found in the MSYS2 tree would run the Windows one -- and its output is not
 * the same.  This is the search `_wspawnvp` did, which is what `Exec` promised
 * before the helper: PATH order, then the extensions a program can have. */
static wchar_t *find_command(const wchar_t *command)
{
    if (!command || !*command)
        return NULL;
    if (wcschr(command, L'\\') || wcschr(command, L'/') ||
        wcschr(command, L':'))
        return _wcsdup(command);

    DWORD length = GetEnvironmentVariableW(L"PATH", NULL, 0);
    if (length == 0)
        return NULL;

    wchar_t *path = malloc(length * sizeof(wchar_t));
    if (!path)
        return NULL;
    if (!GetEnvironmentVariableW(L"PATH", path, length)) {
        free(path);
        return NULL;
    }

    /* A bare name is not an executable: Windows runs `cmd.exe`, not the
     * extensionless `cmd` script some MSYS2 directories carry.  A name that
     * already has an extension is taken as it is. */
    const wchar_t *extensions[3];
    size_t         count = 0;

    if (wcschr(command, L'.')) {
        extensions[count++] = L"";
        extensions[count++] = L".exe";
    } else {
        extensions[count++] = L".exe";
        extensions[count++] = L".com";
    }

    wchar_t *copy  = _wcsdup(path);
    wchar_t *found = NULL;
    wchar_t *save  = NULL;

    free(path);
    if (!copy)
        return NULL;

    for (wchar_t *dir = wcstok(copy, L";", &save);
         dir && !found; dir = wcstok(NULL, L";", &save)) {
        size_t length_dir = wcslen(dir);

        if (length_dir >= 2 && dir[0] == L'"' && dir[length_dir - 1] == L'"') {
            dir[length_dir - 1] = 0;
            dir++;
        }
        if (!*dir)
            dir = L".";

        for (size_t i = 0; i < count && !found; i++) {
            size_t  size = wcslen(dir) + wcslen(command) +
                           wcslen(extensions[i]) + 2;
            wchar_t *candidate = malloc(size * sizeof(wchar_t));

            if (!candidate)
                break;
            wcscpy(candidate, dir);
            wcscat(candidate, L"\\");
            wcscat(candidate, command);
            wcscat(candidate, extensions[i]);
            if (is_file(candidate))
                found = candidate;
            else
                free(candidate);
        }
    }

    free(copy);
    return found;
}

static void say(const char *text)
{
    DWORD written = 0;

    WriteFile(standard_handle(2), text, (DWORD)strlen(text), &written, NULL);
}

int WINAPI WinMain(HINSTANCE instance, HINSTANCE previous, LPSTR command,
                   int show)
{
    (void)instance;
    (void)previous;
    (void)command;
    (void)show;

    int       argc = 0;
    wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);

    if (!argv || argc < 2) {
        say("bintana-exec: no command\n");
        LocalFree(argv);
        return 2;
    }

    size_t size = 0;
    for (int i = 1; i < argc; i++)
        size += wcslen(argv[i]) * 2 + 4;

    wchar_t *line = malloc(size * sizeof(wchar_t));
    if (!line) {
        LocalFree(argv);
        return 2;
    }
    line[0] = 0;
    for (int i = 1; i < argc; i++) {
        if (i > 1)
            wcscat(line, L" ");
        append_quoted(line, argv[i]);
    }

    STARTUPINFOW si;
    ZeroMemory(&si, sizeof si);
    si.cb         = sizeof si;
    si.dwFlags    = STARTF_USESTDHANDLES;
    /* GSubprocess gives the child *CRT descriptors* 0, 1 and 2; the OS
     * standard handles need not be the same ones, especially in a
     * GUI-subsystem process. */
    si.hStdInput  = standard_handle(0);
    si.hStdOutput = standard_handle(1);
    si.hStdError  = standard_handle(2);

    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof pi);

    wchar_t *program = find_command(argv[1]);

    if (!CreateProcessW(program, line, NULL, NULL, TRUE, CREATE_NO_WINDOW,
                        NULL, NULL, &si, &pi)) {
        char message[512];

        _snprintf(message, sizeof message,
                  "bintana-exec: cannot start the child: Windows error %lu\n",
                  (unsigned long)GetLastError());
        message[sizeof message - 1] = 0;
        say(message);
        free(program);
        free(line);
        LocalFree(argv);
        return 127;
    }
    free(program);

    /*
     * **The job is what makes Stop/Kill reach what the child started.**  A
     * nested job is fine on Windows 8 and later; where the assignment is
     * refused, the child still ends when this helper does, and only a
     * grandchild could survive.
     */
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;

        ZeroMemory(&limits, sizeof limits);
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                &limits, sizeof limits);
        AssignProcessToJobObject(job, pi.hProcess);
    }

    WaitForSingleObject(pi.hProcess, INFINITE);

    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);

    /*
     * **The group, not just the leader.**  A wrapper that leaves a child
     * holding the pipe is the case `Exec` has a timeout for; exiting here the
     * moment the leader ends would close the job and cut that child short
     * before the caller's `Stop` or `Timeout` could reach it.  Wait until the
     * job is empty; a caller that wants to end it sooner kills this helper,
     * and KILL_ON_JOB_CLOSE takes the rest.
     */
    if (job) {
        for (;;) {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info;

            if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation,
                                           &info, sizeof info, NULL) ||
                info.ActiveProcesses == 0)
                break;
            Sleep(10);
        }
        CloseHandle(job);
    }

    free(line);
    LocalFree(argv);
    return (int)code;
}
