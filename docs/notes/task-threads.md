# Task: what a thread costs here
- **A class id crosses runtimes, and a first attempt at this assumed it could
  not.** `JS_NewClassID` allocates out of `rt->js_class_id_alloc` -- per
  runtime -- and `JS_NewClass1` accepts any id under 65536, growing
  `rt->class_array` to fit. So an id the main runtime assigned registers
  verbatim in a worker's. The module-level `static JSClassID` variables are
  process-global C storage, but `install_globals` finishes before any thread
  exists, which makes each of them written once at boot and read-only after.
  The abandoned version spent seven hundred lines on a worker decimal of its
  own for want of that fact, and it rounded differently: `(10/3)*3` answered
  `9.999999999` inside a worker and `10` outside one. **Measure the engine
  before writing a second implementation of something the process already
  has.**
- **The frontier for a worker is callbacks, not writes.** `File.Save` is
  `g_file_set_contents`; it is no less safe from a thread than the `Exec` that
  already writes beside the window. What cannot cross is a `GSource` or a
  `GFileMonitor`, because it fires on the main thread holding the worker's
  context -- which is why `File.Watch` was the genuinely dangerous name on a
  list that called it a write. Measured: every mutable process-global in the
  modules a worker runs is five variables (`watch_jobs`, `exec_jobs`,
  `timers`, `paste_jobs`, `dialog_jobs`, all in bta_sys.c) and the rule takes
  all five. What keeps a global list is what has work in flight, and what has
  work in flight is what has callbacks.
- **A refusal with a trigger can still be wrong, and stating the trigger is
  what makes that findable.** The writes were refused "until there is a lock",
  which is a deadline rather than a doctrine and so survived review -- and the
  deadline was still aimed at a danger that does not exist. `File.Save` is
  `g_file_set_contents`, atomic by temporary-and-rename, so two threads saving
  one path cannot tear it; what concurrency costs here is the **lost update**,
  which is a *sequence* and which no lock the runtime puts on a call could
  ever reach. The writes came back before `Lock` did, and the plan's phase 2
  turned out not to depend on its phase 3 at all. **Before promising a feature
  will lift a refusal, measure whether the refusal is about anything.**
- **A refusal states its expiry or it becomes doctrine.** The writes are
  refused today with *"a task cannot write yet -- two writers need a lock to
  order them, and there is none"*, not with *"a task reads the disk, it never
  writes it"*. The first is a deadline with `docs/plans/task-plan.md` behind
  it; the second is a philosophy nobody agreed to, and it is what got the
  first attempt abandoned.
- **`bta_widgets_init` cannot run twice, and that is what split the prelude.**
  It keeps each class's `proto` and `ctor` in the process-global class table,
  so a second runtime running it would overwrite the main thread's with values
  of its own -- unlike the class *ids*, which are only numbers. rad.js used to
  reach `Widget` at the top level, so it could not be evaluated without one;
  the widget half moved to `runtime/js/forms.js` and the main thread evaluates
  both. `defaultsFor` and `sameValue` stayed behind because `Record` uses them
  and neither is about widgets.
- **`g_main_context_invoke` with no owner dispatches synchronously -- on the
  worker.** A task that finished between `Main` returning and the console loop
  starting had its delivery run on its own thread, which then joined itself and
  hung forever: green in every suite run (the loop is always up there) and a
  hang in the one program that quit early. Delivery goes through `g_idle_add`,
  which never executes in the attacher and waits for a loop that may still
  start; teardown joins what never got delivered. The `task_on_main` check
  stays as the guardrail.
- **One shot and exactly-once are what make cancellation a flag and not a
  protocol.** A stopped or stale answer still arrives, so every run retires by
  generation where the answers land -- `examples/usage` is the shape -- and a
  second `Start` is refused rather than queued, because a queue of stale jobs
  is the thing the generation was built to drop.
- **A task file is found by class name, and only the basename matches.** A
  second class in the same file is invisible to the worker: the index maps
  `<name>.js`, not declarations, so `class Helper extends Task` inside
  `WidgetsForm.js` answers `cannot find task class`. One file per task class,
  named alike -- the `.form` bargain, over `.js`.
- **A cancellation flag and an interrupt handler cannot read the same
  number.** `Stop()` was given a cooperative half -- `this.Stopping`, so a
  worker can report what it has and return -- and it did nothing at first:
  both the flag and QuickJS's interrupt handler were reading `job->stop`, so
  the hard abort always won the race and `Run` never reached the line that
  looked. They had to become separate states (1 asked, 2 timed out, 3 forced)
  with the handler firing only on `>= 2`. **Adding a cooperative path means
  taking the pre-emptive one out of the way first**, and the test for it is
  whether any work survives, not whether the flag reads true.
- **Cancelling a thread is asking, and every runtime that offered to insist
  took it back.** `Thread.Abort`, `Thread.stop` and `pthread_cancel` are all
  withdrawn or poisoned, so `Stop()` asks and `KillAfter` enforces -- `Exec`'s
  two stages, with a flag where that one has a signal -- and teardown waits a
  bounded two seconds and then casts an unresponsive worker adrift with its
  job's **live reference deliberately never dropped** -- the job is refcounted
  now, so the deliberate leak is said in the same vocabulary as everything else
  that holds one. Freeing memory a live thread still writes to is
  worse than leaking it on the last line before exit. `GCancellable` is the
  only thing that reaches a thread blocked in native code, and it was measured
  and deferred: one of the six verbs a worker can block in takes one, and it
  is not the one that hangs. See docs/plans/task-plan.md.
- **`Lock.Hold` releases in C, and that is what makes it correct rather than
  tidy.** A forced `Stop()` ends a worker at an arbitrary opcode, so an
  `Enter`/`Leave` pair written in JavaScript would leave the lock held for the
  life of the process and every other thread asking for that name blocked until
  teardown cast it adrift. With the unlock after the `JS_Call` it runs whether
  the function returned, threw, or was interrupted -- measured by aborting a
  task inside a hold and taking the same lock 0 ms later. **In every other
  language the callback form is a convenience; here the alternative is a bug.**
- **The lock is recursive because the silent failure is the expensive one.**
  `GRecMutex` and not `GMutex`: `lock` is reentrant in .NET, `synchronized` in
  Java, `TCriticalSection` in Delphi. A nested `Hold` of one name -- a function
  that saves something calling another that saves something -- is an instant
  deadlock with a plain mutex, with no error and no output, which is why the
  suite asserts the nesting rather than describing it.
- **Splitting a file by line range moves whatever was sitting in the range.**
  `File.LoadJson` and `File.SaveJson` went to `forms.js` with the widget block
  because they were physically inside it, and they are not about widgets --
  `Settings` in rad.js calls them, and a worker (which runs rad.js and not
  forms.js) lost them silently, since the failure is `not a function` at call
  time and not at load. The cross-reference check that caught `defaultsFor`
  and `sameValue` was run in one direction only: what the block *defines and
  the rest uses*. Run it the other way too -- what the block defines that has
  nothing to do with the block's subject.
- **`JS_SetPropertyStr` does not take ownership of its name.** The abandoned
  version leaked one C string per property of every message it sent, through
  `JS_SetPropertyStr(ctx, out, JS_ToCString(ctx, key), copy)`. Walk properties
  by **atom** (`JS_GetOwnPropertyNames` + `JS_GetProperty`/`JS_SetProperty` +
  `JS_FreePropertyEnum`) and there is no string to forget.
