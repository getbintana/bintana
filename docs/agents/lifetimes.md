# Lifetimes and memory

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## Memory rules

- Controls point back at their form, so the object graph has cycles. Report the
  edge in `gc_mark` or forms never get collected.
- **A wrapper's unref disposes the whole tree, and GTK dispatches while it does.**
  Unhooking the widget being finalised is not enough: `gtk_window_dispose` moves
  the focus, which emits `focus-leave` on a child that is still connected and
  whose `w->form` is the object being freed in the same cycle. `widget_disconnect_tree`
  unhooks everything under it first, and the finaliser clears the back-pointer on
  `w->slot` as well as on `w->gtk` or that walk finds a freed `BtaWidget`.
- `JSValue`s held from C across an async boundary (`Exec`, `Dialog`, timers,
  menu actions) are strong references the collector cannot see. Free them on
  **every** exit path, including runtime teardown while a child still runs —
  `JS_FreeRuntime` aborts on anything left alive. See `bta_sys_cleanup`.
- **A shown form is the same kind of reference, and it is what makes
  `new AskForm().Show()` the whole of a dialog.** `form_hold` (`bta_controls.c`)
  takes the wrapper in `Show` and `form_drop` releases it when the close is
  allowed — **not** in `Close()`, which `Form_Close` may veto; `HideOnClose`
  releases too, and a later `Show` takes it again. It is deliberately absent from
  `gc_mark`: a cycle detector that could see it would collect the object it
  protects, so a form still held at teardown has to be swept by
  `bta_forms_cleanup` or `JS_FreeRuntime` aborts. `tests/widgets`' `FormKeepalive`
  leaves one open (the sweep) and closes another (the drop). **Before this,
  sixteen IDE dialogs kept a module-level array alive by hand** because a form
  nothing referenced was collected and its window was left on screen with every
  handler disconnected. Measured with a probe on its own `Xvfb` **plus a real
  window manager** — under a bare `xvfb-run` a synthetic click never reached GTK
  at all (`xdotool getmouselocation` reported the pointer over no client window,
  with the window mapped and focused; a window manager started on the same `Xvfb` made
  the first try work): with the hold, a click before and a click after a 400 000-object
  ball both answer; with `form_hold` compiled out, the first answers and the
  second is silent **while the window is still on screen**, which is the
  reported symptom exactly.
- The class table's prototypes and constructors are static and outlive the
  context; `bta_widgets_cleanup` drops them.
- **"Every exit path" includes the branch that gives up, and that is the branch
  nothing exercises.** `bta_task_cleanup` waits a bounded two seconds and then
  casts an unresponsive worker adrift with its *job* deliberately unfreed --
  which is right, and documented in the `Task` notes below. What the `continue`
  also skipped was `JS_FreeValue(job->ctx, job->self)`: the **proxy** is an
  ordinary main-context `JSValue` that no JavaScript scope owns, the worker
  never touches it, and leaving it alive left an object on `gc_obj_list`. So the
  process printed *"1 task still inside a native call at exit ... closing
  anyway"* and then aborted in `JS_FreeRuntime`'s assertion two lines later. The
  rule above was followed on the path that succeeds and not on the one that only
  runs after something already went wrong. **When you write a give-up branch,
  read the success branch next to it and account for every release in it.**
- **`memcpy` with a length of zero is still undefined behaviour if the pointer
  is `NULL`**, and an empty `Bytes` carries `NULL` on purpose. `Bytes.Concat`
  copied unguarded, so any concatenation touching an empty value was formal UB
  a UBSan run reports -- harmless only because glib's allocator does not poison.
  `bta_bytes_get` exists to hand back `""` instead; a copy that bypasses it
  guards by the length itself.
- **An idle source queued from another thread cannot be tracked by its id, and
  the symmetry that suggests it is a trap.** A `BtaTaskJob` owns four sources.
  `timeout_src` and `force_src` are armed on the main thread, so keeping their
  ids on the job and removing them there is correct. `task_deliver` and
  `task_progress_drain` are attached from inside the **worker**, and the same
  treatment is a use-after-free of its own: the loop can dispatch the source and
  free the job before `g_idle_add_full` has returned into the assignment, and
  the worker then writes a `guint` into freed memory. Reaching for the pattern
  two lines above in the same struct is exactly what makes this one easy to get
  wrong.
  The answer is **a reference per queued source** -- `task_job_ref` before the
  attach, `task_job_unref` as the `GDestroyNotify` -- which needs no id, no lock
  and no assumption about when GLib dispatches. It also replaced an invariant
  that lived nowhere: the old code was safe only because GLib dispatches
  equal-priority sources in insertion order, so a drain queued before a delivery
  always ran before the delivery freed the job.
  **And the exposure was not theoretical.** `bta_task_cleanup` takes the whole
  job list and frees what it can join -- but the worker attaches `task_deliver`
  *after* saying `ended`, which is the very thing that wait is waiting for.
  Measured with eight tasks started and `Application.Quit(0)` on the next line:
  the live reference is dropped with the refcount at **2 in all eight cases**,
  i.e. every one of those jobs had a delivery still attached and would have been
  freed under it. Nothing dispatches the default context after teardown today,
  which is the only reason it never crashed -- and the reason no test can go red
  for it, so this paragraph is the record.
- **A cache of the filesystem must not believe a negative answer.** `form_path`
  rebuilds its index on a miss and says why -- *"a file that appeared since,
  which is the normal state of affairs while an IDE is writing forms in the same
  directory it is running from"*. `task_class_file` carried a comment claiming
  the same rebuild and did not do it, so a `<Name>.js` created while the program
  ran stayed invisible for the life of the process. It rebuilds once on a miss
  now, and the cost settles it rather than the symmetry: a miss means
  `Task.Start` is about to throw *cannot find task class*, so the walk is on the
  path that was going to fail anyway and never on the one that succeeds. The
  narrow shape this is reachable in -- the class declared in a file named after
  something else, its own `<Name>.js` written later -- is what `testTask` drives,
  as a **child process**, because the cache lives for a process and the
  alternative was writing a `.js` into the suite's own project directory.
- **There are nine hand-rolled async job shapes, and two of them have already
  forgotten to release.** `WatchJob` (`bta_sys.c`), `ExecJob`, `TimerJob`,
  `PasteJob`, `DialogJob`, `HttpJob` (`bta_http.c`), `BtaTaskJob`
  (`bta_task.c`), `PrintRun` (`bta_printer.c`) and `BtaMedia` (`bta_media.c`)
  each carry a `JSContext`, one or more `JSValue`s, a list of live jobs and a
  free path that has to release on **every** exit. `bta_widget_watch` and
  `http_job_alive` exist because two of them did not -- they are the repairs,
  not the design. So when you add the tenth, or touch one of the nine, the
  question to ask first is *which exit path did the one next to me forget*: the
  adrift `Task`'s unreleased proxy and its untracked idle sources -- the two
  paragraphs above -- were both in `BtaTaskJob`, and neither was found by
  reading that struct's success path.
  A shared base for *a job with values and a dead flag* would shrink the surface
  where forgetting is possible; nobody has built one, and this paragraph is the
  cheaper half of that.
  **`ExecJob` was the third, and CI's core dump is what named it.** A job ends
  when stdout drains and the child is reaped -- descriptor 3 ending is *not*
  the child ending, on purpose -- so `exec_maybe_finish` freed it with the
  `Control` read still armed, and `exec_job_free` never cancelled
  `job->cancel` (only teardown did). The debugger's last event races its exit;
  when the exit won, the read completed into freed memory and
  `on_exec_line` segfaulted in `JS_IsFunction` -- exit 139 on the
  `no-unix-print` job, one run in several, and never in forty local runs. And the
  callback read `job->err`/`job->control` *before* checking for the cancel, so
  even teardown's cancel was a read of freed memory. Now: the free cancels,
  the callback finishes the read before touching the job and also asks
  `exec_jobs`, the context and the handler are held across the `JS_Call`
  (a handler can spin a nested loop that ends the job), and the next read is
  armed only if the job survived it. `testExecControlLate` makes the race
  deterministic -- a grandchild writes to descriptor 3 a third of a second
  after its parent exits -- and is `heap-use-after-free` under `asan.sh`
  without the fix. **A read that outlives what says the run is over has to be
  cancelled by whatever frees the job, not by teardown alone.**
  **And the other half of that race was losing lines, not memory.** Once the
  read was cancelled at the free, whatever the child wrote on descriptor 3
  just before it exited -- the debugger's last logpoints -- was dropped
  whenever the exit and stdout's end were dispatched before the read that
  would deliver them: the `no-libsecret` job lost both of `testDebuggerLog`'s
  logs, the exit callback then threw reading `logs[0].text`, the chain never
  reached the next test and the run **timed out** after 1200 s instead of
  failing. Measured with a child that writes five control lines and exits, 200
  times on a machine with sixteen busy loops: **128 of 200 runs lost lines**
  on the old code, none now. A finished run waits for the control stream's end
  too, but at most `EXEC_CONTROL_LINGER` (250 ms) -- the child is reaped, so
  what it wrote is already in the pipe, and what is still open after that is a
  grandchild's, which `testExecControlLate` still holds is dropped. And an
  exit callback in a test reads what it asserts through a guard: **a throw in
  the callback that continues a chain is a hang, not a red line.**
  **The next run of the same job hung the same way one test earlier**, and
  that one was the test's own race: `testDebuggerRunTo` sent `runto` *and*
  `continue` at `ready`, but `runto` already lets the program go -- so on the
  runner the spare `continue` arrived while the program sat at line 5 and
  released it before the second `runto` was asked, leaving one stop where two
  were asserted and `stops[1].frames` throwing. The IDE sends `runto` alone,
  and the test does now. **An order that releases the program is sent once
  per stop**; a second one is consumed by whatever stop comes next.
  **And `Write` was the other half of that struct's trouble: it blocked.** A
  synchronous `g_output_stream_write_all` on the UI thread deadlocks with any
  child that writes while it reads -- once `cat`'s stdout pipe fills it stops
  reading, the write waits for it, and the reader that would drain it is a
  callback on the loop the write is holding. 300 KB into `cat` hung for good
  (`testExecWriteLarge`). Lines are queued on the job (`unwritten`) and written
  one async operation at a time; each operation owns its `GBytes` and names the
  job only to look it up in `exec_jobs` when it answers, because the job may
  be freed -- and the operation cancelled -- while a line is in flight.
  **And a reaped leader is not an ended job.** Every signalling verb stopped at
  `reaped`, so `Timeout`, `Stop()` and `Kill()` did nothing to `sh -c "sleep 30
  & echo up"`, whose `sleep` holds stdout: no exit callback, a console program
  that never ended. `exec_job_signal` signals the **group** when the leader is
  reaped and the output is not drained -- a group keeps its id while any member
  lives, and an open pipe says one does -- and never falls back to `kill(pid)`,
  which after the reap could be a stranger. `testExecGrandchild` waits thirty
  seconds and fails three assertions on the old code.
  **`PrintRun` was the fourth to forget, and at teardown.** Its callback was
  released only by `done`, so `Printer.Send(a, cb)` then `Application.Quit(0)`
  aborted in `JS_FreeRuntime` (exit 134, `testPrintAtQuit` runs it as a
  child). `bta_printer_cleanup` cancels what is still waiting, cut loose from
  its handlers first. The run also holds the control's own wrapper now
  (`self`), since `run->w` was a raw `BtaWidget*` and a control built only to
  be printed could be collected under an open dialog -- the AudioPlayer
  keepalive's lesson, and absent from `gc_mark` for the same reason.
- **`Terminal.Run` was a tenth async shape, and nobody had counted it.**
  `vte_terminal_spawn_async` answers on a later turn and was handed the raw
  `BtaWidget*`, with no cancellable and nothing holding it: `t.Run(cmd);
  t.Delete(); t = null` plus a collection before the answer wrote into freed
  memory -- measured, twenty terminals and a 400 000-object ball are a
  `heap-use-after-free` in `on_spawned` under `build-asan`, and clean with the
  fix. The callback is handed the **scroller** now, referenced for the spawn,
  and asks it for its `BtaWidget` (`BTA_WIDGET_QUARK`, which the finaliser
  clears); none means nothing to report to, and the pty hangs the child up when
  the terminal goes. That is the cheap shape for any GIO-style callback on a
  widget: a reference to the GObject and a lookup through the quark, rather than
  a pointer to the wrapper. `testTerminalSpawnLifetime` runs it as a child, so
  under `tests/asan.sh` the report lands in the log that script reads.
- **A callback the program can replace from inside itself has to be held for
  its own call.** `Http.Server`'s `Request` is documented as replaceable while
  running, and `http_server_set_request` releases the old function at once --
  so a handler that did `srv.Request = next` freed the closure it was
  executing. **What is freed is the closure, not the code** (an arrow's
  bytecode lives in the constant pool of the function around it), so the
  use-after-free only happens when the handler reads a *captured* variable
  afterwards: a first test that allocated but captured nothing passed under
  ASan against the bug, and one that reads `served++` after the swap is
  `heap-use-after-free`. The handler is `JS_DupValue`'d across the call, and
  nothing after the call reads the server. Every other callback shape was
  checked: timers are held by GLib's dispatch, `File.Watch` and the Http
  deliverers by their `calling`/`dead` pair, events by `JS_GetProperty`'s own
  reference -- `Request` was the only one a program could replace mid-call.

## More lifetime traps

- **A `JSValue` in a wrapper's opaque slot wants `gc_mark`, and its finaliser
  wants `JS_FreeValueRT` -- not a `JSContext*` carried beside it.** `Http`'s
  client was built the other way first: the defaults object `Dup`'d into
  `HttpClientData`, the `JSContext*` kept in the struct to free it with, a
  `GList` of every live client, and a sweep in `bta_http_cleanup` -- the
  `ExecJob` mold, applied where it does not belong. `ExecJob` needs all that
  because a job is owned by a list and reachable from nowhere the collector
  looks; a *wrapper's* opaque struct is reachable, and the runtime already
  hands its finaliser the `JSRuntime*`. Two costs to getting this wrong: the
  scaffolding, and the cycle -- `srv.Request = (req) => { ... srv ... }` is
  the shape every server is written in, and without `gc_mark` that pair is a
  listening socket nothing can reach and nothing can free. `bta_menu.c`'s
  `action_gc_mark` was the answer the whole time. What a list is still for is
  a resource outside the process: `http_servers` survives because a held port
  is not the collector's problem.
- **A chain of callbacks that holds its own list is garbage, and whether it is
  collected before teardown is luck.** `testHttp` kept its steps in an array
  every step closed over, so the finished chain was a cycle nothing referenced
  -- collected only if the collector happened to run before `JS_FreeRuntime`,
  which aborts on whatever is left. Two runs in three aborted with every
  assertion green, and one passed for no reason at all. The last step empties
  the array (`steps.length = 0`); with no cycle the refcounts fall to zero on
  their own and no collection has to happen. Anything that chains callbacks
  through a shared table wants the same last line.
- **And a chain nobody counts ends the run early instead of failing.** The same
  `testHttp` once reported six assertions fewer with nothing red: on a loaded
  machine `Exec`'s tail reached `finish()` mid-chain, and `finish()` only waits
  for `waiting`. The chain is `waiting++` at its start and `waiting--` at its
  end now -- every request in it carries a `Timeout`, so the counter cannot
  stick. An async helper that neither counts nor times out is a hang or a
  silence, and this codebase has had both.
- **A finalised `BtaWidget` must not still be reachable from GTK.** The
  `GtkWidget` usually outlives it (the container holds the last reference) and
  GTK emits signals *while being destroyed*: a notebook removing a page emits
  `switch-page`, a list box emits `row-selected`. At shutdown that runs with
  siblings already freed. `widget_disconnect_all` unhooks by `data` on
  `gtk`/`inner`/`slot`, on their controllers, and on anything handed to
  `bta_widget_watch` — which is what a module that connects a signal on something
  that is **not** the widget (a `GtkTextBuffer`, a selection model) has to call.
- **Every path that adds a child has to call `bta_widget_adopt`, and every path
  that removes one `bta_widget_release`.** The JS wrapper owns the `BtaWidget`: a
  child only GTK holds gets collected while GTK still shows it, and the next mouse
  motion over it reads freed memory. It bit
  `Notebook.Append`, and went unnoticed while the IDE happened to keep a
  reference to every page of its own. `Notebook.Remove` had the mirror image of it:
  it dropped the page without releasing the reference, so the wrappers piled up.
- **GTK4 keeps an unowned pointer to a window's default widget, and takes a CSS
  class off it when it is replaced.** So deleting the button that is
  `Default` leaves `gtk_window_set_default_widget`'s next call operating on freed
  memory — three GTK-CRITICALs (`remove_css_class`, `queue_draw`,
  `g_object_notify`) at whatever touches the window *after*, which reads like a
  bug in that. `bta_container_detach` clears it for the whole subtree being
  removed, because detaching the panel a default button sits in leaves the
  pointer just as dangling as detaching the button.
- **A window-scoped property cannot be pushed to GTK from its setter, and the
  designer is why.** `Button.Default` is one: the obvious setter calls
  `gtk_window_set_default_widget`, and the designer builds the controls of the
  form it is *drawing* inside the IDE's own window, where `bta_container_attach`
  binds every one of them to `MainForm`. Both cases are then a button whose form
  is a form whose widget is the root window — there is nothing to tell them
  apart, and the drawing would hand the IDE's Enter key to a button on a canvas
  with no test ever noticing. `form_show` resolves it instead: a drawing is never
  shown as a form. The cost is that the declaration is settled at Show and a
  later assignment does not move an open form's default, which is written down
  where the setter is.
- **`bta_widget_watch` holds a reference, so watching a *replacement* keeps the
  original alive.** It refs on purpose -- the pointer has to be valid when the
  handlers are unhooked -- which means a control that swaps its model and watches
  each new one keeps every model it ever made. `TableView` does swap (flat, on
  demand, tree), and a `GtkTreeListModel` that outlived its `Clear()` went on
  asking a now-flat row for its children: `g_object_ref: assertion 'G_IS_OBJECT
  (object)' failed`, a sentence about a NULL store that says nothing about where
  it came from. **Whatever watches a replaceable object has to unwatch the one it
  replaces** -- `g_ptr_array_remove_index_fast` on `w->watched`, which
  `on_form_realized` was already doing for its surface.
- **A value handed over by GLib, sqlite or GTK is borrowed.** `bta_bytes_new`
  copies, and every one of its callers is why: `g_file_get_contents` hands over a
  buffer it expects you to free, a sqlite BLOB belongs to the statement until the
  next `step`, and a base64 decode is `g_malloc`'d. A `Bytes` outlives all three.
- **Changing what a list tracks without changing every writer leaves the
  stale one.** `http_servers` went from *running* to *live* when the
  finalizer took over disconnecting, but `Start` kept its own prepend: every
  start registered twice, the finalizer removed once, and teardown walked a
  dangling pointer -- straight into `remove_auth_domain` on garbage, which
  reads as a bug in auth. The one writer nobody re-read is the regression to
  watch for.
- **A clipboard read and a file dialog are jobs with a pending operation, and
  teardown has to cancel them.** Both passed a NULL `GCancellable` and were
  freed at cleanup with the operation still armed -- the `ExecJob` crash's
  shape, harmless only because nothing dispatches after teardown. Each job has
  its own cancellable now, cancelled at teardown, and the completion asks
  membership of the list before touching the job: **the pointer is compared,
  never read**. `on_paste`'s comment claimed this while the cancellable was
  NULL, so the branch it described could not happen. The same cleanup leaked
  its own reference on the server's auth domain, which `http_server_free`
  always released.
