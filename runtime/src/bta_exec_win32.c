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

#include "bta_win_quote.h"       /* the one quoter, shared with tests/win-desktop.c */

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
     * already has an extension is tried as it is first.  **The batch
     * extensions are searched too**, in `_wspawnvp`'s order: `npm`, `code` and
     * the IDE's own launcher are `.cmd` files, and `g_find_program_in_path`
     * (which decides the helper is used at all) finds them -- leaving them out
     * here made such a command a 127 instead of a run. */
    const wchar_t *extensions[5];
    size_t         count = 0;

    if (wcschr(command, L'.'))
        extensions[count++] = L"";
    extensions[count++] = L".com";
    extensions[count++] = L".exe";
    extensions[count++] = L".bat";
    extensions[count++] = L".cmd";

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
        /* An empty entry is skipped (`wcstok` never hands one out anyway):
         * "the current folder" is POSIX's reading of it, not Windows', and
         * `exec_win_search` in bta_sys.c skips it the same way. */
        if (!*dir)
            continue;

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

/* A batch file, which CreateProcessW runs through `cmd.exe` only when it is
 * named in the command line rather than as the application. */
static bool is_batch(const wchar_t *path)
{
    const wchar_t *dot = path ? wcsrchr(path, L'.') : NULL;

    return dot && (!_wcsicmp(dot, L".bat") || !_wcsicmp(dot, L".cmd"));
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

    /* **Each argument arrives with a `+` in front** (`exec_use_helper` in
     * bta_sys.c): GLib's spawn drops an empty argument on its way here, and a
     * prefixed one is never empty.  Taken off in place, so `argv[i]` is the
     * argument from here on. */
    for (int i = 1; i < argc; i++) {
        if (argv[i][0] != L'+') {
            say("bintana-exec: every argument must start with '+'\n");
            LocalFree(argv);
            return 2;
        }
        argv[i]++;
    }

    wchar_t *program = find_command(argv[1]);
    /* **Not found is not started.**  `exec_use_helper` hands over an absolute
     * path, so this is a caller that did not; letting `CreateProcessW` search
     * instead would run whatever its own order finds first -- System32's
     * `sort` for a PATH that has none. */
    if (!program) {
        say("bintana-exec: the command is not on the PATH the child was given\n");
        LocalFree(argv);
        return 127;
    }
    /* A batch file is named by its full path at the head of the command line
     * and no application: CreateProcessW then starts `cmd.exe /c` with that
     * line itself, which is what `_wspawnvp` did. */
    bool           batch = is_batch(program);
    const wchar_t *head  = batch ? program : argv[1];

    size_t size = wcslen(head) * 2 + 4;
    for (int i = 2; i < argc; i++)
        size += wcslen(argv[i]) * 2 + 4;

    wchar_t *line = malloc(size * sizeof(wchar_t));
    if (!line) {
        free(program);
        LocalFree(argv);
        return 2;
    }
    line[0] = 0;
    bta_win_append_quoted(line, head);
    for (int i = 2; i < argc; i++) {
        wcscat(line, L" ");
        bta_win_append_quoted(line, argv[i]);
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

    /*
     * **The job is what makes Stop/Kill reach what the child started.**  A
     * nested job is fine on Windows 8 and later.  If the assignment is
     * refused there is no group of this helper's own: Stop/Kill still end the
     * helper, but what it started may outlive it; only the runtime's own job
     * could still reach it.
     */
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;

        ZeroMemory(&limits, sizeof limits);
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation,
                                &limits, sizeof limits);
    }

    /* **Started suspended, and let go only once it is in the job**: a child
     * that ran first could start a process of its own before the assignment,
     * and that one would be outside the group nothing then reaches.  This is
     * the race `exec_win_job_open` in bta_sys.c cannot close, because
     * GSubprocess starts *this* helper running; here the call is ours. */
    if (!CreateProcessW(batch ? NULL : program, line, NULL, NULL, TRUE,
                        CREATE_NO_WINDOW | CREATE_SUSPENDED,
                        NULL, NULL, &si, &pi)) {
        char message[512];

        _snprintf(message, sizeof message,
                  "bintana-exec: cannot start the child: Windows error %lu\n",
                  (unsigned long)GetLastError());
        message[sizeof message - 1] = 0;
        say(message);
        if (job)
            CloseHandle(job);
        free(program);
        free(line);
        LocalFree(argv);
        return 127;
    }
    free(program);

    if (job && !AssignProcessToJobObject(job, pi.hProcess)) {
        CloseHandle(job);
        job = NULL;
    }

    if (ResumeThread(pi.hThread) == (DWORD)-1) {
        char message[512];

        _snprintf(message, sizeof message,
                  "bintana-exec: cannot resume the child: Windows error %lu\n",
                  (unsigned long)GetLastError());
        message[sizeof message - 1] = 0;
        say(message);
        TerminateProcess(pi.hProcess, 1);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        if (job)
            CloseHandle(job);
        free(line);
        LocalFree(argv);
        return 127;
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
