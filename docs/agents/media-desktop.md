# Media and the desktop

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## Media

- **A playbin3 owns the sink it was given, so unref-ing after the set is a
  double free.** `g_object_set(playbin, "video-sink", sink)` takes the sink
  into one of its own bins, sinking the floating reference the factory gave --
  the `gst_bin_add` ownership, not a `gst_object_replace` one. The tutorial
  pattern of set-then-unref destroys the sink while the playbin still points
  at it, and the playbin's own finalizer then touches freed memory: two
  `GStreamer-CRITICAL`s (`set_state` on a non-element, `unref` past zero) at
  teardown, nothing while playing. Measured with a three-variant C probe
  (`/tmp` never kept it): flags-only finalises clean, flags+fakesink dies,
  and skipping the unref both lives and finalises the sink with the pipeline
  (weak-ref proved, so it is ownership and not a leak wearing a fix).
- **Teardown waits for NULL, capped, before the unref.** The state change is
  async, and finalising a playbin with one still in flight tears its children
  down under it. Two seconds, so a wedged network source cannot hold teardown
  hostage -- the same shape as every other guard here.
- **Length and seekability arrive after the first frame, not with it -- and
  the frame's own size after that.** `Playing` flips true while `Duration`
  still answers -1 and `Seekable` false; the demuxer has not seen the stream
  yet. A test asserting seekability the moment playback starts fails about one
  way in one; `until(Duration > 0)` first, and `until(SourceWidth > 0)` before
  measuring or saving a frame, because the paintable has nothing in it until
  something is decoded. The same async lag is why `Seek(0.2)` reads
  `Position 0` back on the next line.
- **A player that plays must hold its own JS object.** `function ding() {
  const a = new AudioPlayer(); a.Uri = "done.ogg"; a.Play(); }` played
  *nothing*: the local went out of scope, the refcount hit zero, and the
  finalizer stopped the pipeline -- while the reference documentation said a
  player left playing keeps the program alive. The keepalive is taken in
  `Play` and released at the end, at an error, and at `Pause`/`Stop`, and it
  is deliberately absent from `gc_mark`: it is the pipeline's claim on the
  object, and a cycle detector that could see it would collect exactly what it
  protects. It also closed a segfault -- an `OnEnded` that dropped the last
  reference freed the struct under the emit, and the next line read `m->ctx`
  (`list_del` on 0x0, in `bta_drain_jobs`).
  **A `Video` has no keepalive, so it had the same hole left open.** Its
  engine state is the picture's qdata, not a JS reference, and `media_on_eos`
  and `media_on_error` both ended in `media_drop_self(m)` -- written for the
  AudioPlayer, whose `self` keeps `m` alive across the emit. A handler that
  takes the Video out (`Vid_Ended() { this.Vid.Remove(); this.Vid =
  undefined; }`) finalised the widget, the qdata and `m` inside the emit, and
  the drop read freed memory: `heap-use-after-free` under build-asan, on both
  roads. Whether it is a video is read before the event and nothing after it
  touches `m` for one. `testVideoDroppedInHandler` runs the error road as a
  child, which needs no clip.
- **Never ask a pipeline whether it is playing.** `gst_element_get_state`
  with a zero timeout reads not-PLAYING during a flushing seek -- which is
  what `Loop` is -- and while a network stream refills. The console loop asks
  "is anything still owed an answer" 50 times a second, so a looping cue
  ended the program at a loop boundary, at random: a 0.3 s clip exited after
  2.5 s, 4.3 s and 4.6 s in three runs, and a 5.8 s clip once at 11.8 s and
  once not at all in 40 s. `Playing` is now what `Play` asked for, cleared by
  `Pause`, `Stop`, the end and an error -- one flag, and the same answer for
  JS and for the loop.
- **An optional dependency may not break the *designer*.** Without GStreamer
  every `Video` getter threw, which sounds like the sqlite mold and is not:
  the property grid reads every value of the selected control and the
  serialiser reads them all again to save, so a runtime built without
  GStreamer could not draw, save or even *load* a form with a `Video` in it (a
  declared `Uri` is assigned like any other property, and the load died with a
  dialog). The rule the optional-dependency mold actually needs: the verbs
  refuse, the state is kept, the properties answer.
- **One surface, two engines.** `Video` and `AudioPlayer` are the same
  seventeen members over the same struct, so the accessors are written once
  and both `JSCFunctionListEntry` tables point at them -- the resolver answers
  for either (opaque first, then the picture's qdata). What differs by build
  is behind ten `engine_*` functions with a GStreamer version and a version
  that refuses. Written the other way it was 230 lines of accessor said twice
  and a 200-line stub saying it a third time.
- **`gst_init` is 6 ms warm and 573 ms cold**, measured with a three-line
  probe against a thrown-away registry, so it happens on first use and not in
  `bta_media_init`. It was a bill every program in the tree paid, the IDE
  included, for a feature most of them never call.
- **`Buffering` is a percentage of the queue's target, not of the download.**
  Held at PAUSED until it reads 100, a stream served *below* its own bitrate
  never starts at all -- the percentage sat at 1 for as long as it was
  watched. That is not the holding logic being wrong: `gst-launch` on the same
  URL does not reach the end either, because there is nothing there to play
  through. Served just *above* the bitrate, the same clip read 1, 2, 12, 22,
  ..., 81 and then started, and the picture ran to the end. Both measured
  against a local server throttled by hand, which is the only way to see any
  of this -- and worth rebuilding (`python3` + `time.sleep`) before touching
  the buffering path again. Two things that will waste an afternoon there: the
  throttling server must be threaded (a single-threaded one blocks on the
  probe connection souphttpsrc abandons, which looks exactly like a stream
  that never fills), and `pkill -f serve.py` kills the shell that is editing
  `serve.py`.
- **An event dispatched through a variable is an event nothing checks.**
  `media_emit(m, "Ended", ...)` calling `bta_emit(w, event, argc, argv)` was
  invisible to `tests/api/Check.js`, whose regex wants `bta_emit` beside a
  literal name -- so `Error` grew a second argument with nothing to notice
  that three documents said `Error(message)`. Both events are now emitted with
  their names spelled out at the call site.
- **The engine is playbin3 plus the paintable sink, and neither GstPlayer nor
  GtkVideo.** `GstPlayer` (`gstreamer-player-1.0`) is the deprecated API
  `GstPlay` replaces, and neither ships a GTK4 renderer -- both would still be
  handed a `gtk4paintablesink` through an adapter of our own, a dependency for
  no feature this surface uses. `GtkVideo` takes a `GFile` and nothing else:
  no RTSP URI, no digest credentials, no pipeline to tune. What a camera needs
  is `source-setup` into `rtspsrc`'s `user-id`/`user-pw`, which only a pipeline
  of our own has.

### The elements API (`Media.Element`)

Each of these was measured while building it, and each one shaped a rule.

- **`gst_element_get_bus` on a child answers the bin's *internal* bus.**
  `gst_element_get_bus(pipeline)` and `gst_pipeline_get_bus(pipeline)` are one
  object; a child's is a different one (`gst_bin_init` builds it,
  `gst_bin_add_func` distributes it), and a timed pop on it refuses the way a
  bus with no poll does -- while the application's bus answers
  `state-changed`. `Element.Bus` walks up to the first pipeline instead.
- **Adding an element to a bin unlinks its pads** -- "If the element's pads
  are linked to other pads, the pads will be unlinked before the element is
  added to the bin", its documentation. So the order is `Add` then `Link`, and
  `Link` refuses two elements that do not share a parent rather than making a
  link the next `Add` throws away in silence.
- **A child added to a PLAYING pipeline stays in NULL** until
  `gst_element_sync_state_with_parent` -- `gst_bin_add` leaves it to the
  caller -- which `Element.Add` calls for it. Measured right after the add, and
  reaching PLAYING with data linked.
- **A pipeline set to NULL without EOS leaves a writer's placeholders.** A
  one-second `wavenc` run wrote 360 kB whose header fields said ~2 GiB
  (`0x7FFFFFE4`) in both sizes; with `Eos()` first they are exact. `Eos` exists
  because of that, and `gst-launch-1.0` carries `-e` for the same reason.
- **An asynchronous-only signal delivery loses `pad-added`.** Measured in C
  and in the runtime: the emitting thread pushes into the pad before the main
  loop gets there, and `wavparse` stops with "streaming stopped, reason
  not-linked". The marshal runs the handler *inline* when the emission is
  already on the main thread, and otherwise queues it and **blocks the
  emitting thread** until it has run -- capped at two seconds, after which it
  runs late. `source-setup` cannot be deferred either, for the credentials'
  sake.
  **Except inside a teardown the runtime started**: `elem_teardown` runs
  from the finaliser, and taking a pipeline to Null there makes a
  `decodebin` emit `pad-removed` on the main thread. Delivered inline, the
  handler ran inside the QuickJS finaliser, and one that allocated (two
  thousand small objects) segfaulted right after the EOS that let go of the
  pipeline. `media_no_inline` counts those C-initiated state changes and
  unrefs (the teardown, a Bus's last reference to its pipeline, the error
  accounting), and a main-thread emission inside one is queued and not
  waited for. `tests/media`'s `removedInTeardown` crashes without it.
- **The closure owns a reference to its subscription.** A
  `g_signal_handler_disconnect` on the main thread does not wait for an
  emission another thread is already running, and the marshal read
  `closure->data` before taking its own reference -- a decodebin announcing
  two streams from two threads, the first handler unsubscribing, was a
  use-after-free in the second's prologue. The count is the table's, the
  closure's (dropped by a finalize notifier: GLib holds the closure across
  every invocation) and one per delivery, and the detached check and the
  delivery's reference are one step under `media_sig_mutex`.
- **One watch per bus, because bus sources consume what they see.** Two
  `gst_bus_add_watch` calls on one bus *split* the messages -- a program
  subscribed to `eos` missed it every other run, which is how it was found.
  `media_watches` keeps one source per bus, with the playing elements and the
  `Bus` wrappers as its listeners.
  **The dispatch walks a copy, each wrapper held.** `pipe.Bus` is a new
  wrapper per read, so one bus has several, and a handler that took
  *another* one off (`b3.On("eos", null)`) unlinked the very link the walk
  had read as its next: a segfault under `MALLOC_PERTURB_`. And an element
  answered by an EOS leaves the watch after the handlers only if none of them
  played it again -- an `eos` handler that restarted the pipeline was taken
  out for good, its next EOS answered nothing, and a console program never
  ended (`busDrop` and `restart` in `tests/media`).
- **`GstState` numbers VOID_PENDING 0 and NULL 1**, so the four words are not
  a dense array from zero; `MEDIA_STATES` is indexed by the enum itself, after
  a `State` getter answered "Ready" for `"Null"`.
- **A subscription is a claim on the element's life -- held by the
  pipeline's wrapper, not by nobody.** A `decodebin` in a local variable is
  collected the moment the function that built the graph returns -- its
  `pad-added` subscription with it -- and the pad is never linked; so `On`
  (and `Bus.On`) holds the wrapper. The first version held it from C,
  invisible to the collector, until the last handler was taken off, which no
  program does: every recording of `examples/recorder` left its Bus
  wrappers, its bus and watch (two descriptors) and the form its handlers
  named, for the life of the process -- 20 pipelines, 40 descriptors. Now the
  claim (`MediaClaim`) is held by a live wrapper of the element's pipeline,
  which *marks* it: the subscription lives while the pipeline plays (its
  play keepalive) or the program holds it, and the cycle a handler naming
  `pipe` makes is one the collector breaks. An element in no pipeline holds
  its own claim until `Add` hands it over; a pipeline's own handlers need no
  claim at all. The pipeline's finaliser lets its claims go *first*, so its
  children are finalised before it is taken to Null under them.
  `subscriptionsGo` in `tests/media` counts the descriptors.
- **`Set` validates against the spec before it sets.** `g_object_set_property`
  answers a value outside the range with a GLib-CRITICAL and keeps the old one
  (`volume` set to 20 read back 1); `g_param_value_validate` first makes it a
  RangeError. A `guint` goes through a number, not `bta_to_int` (3e9 is a
  legal `max-size-bytes`), and a construct-only property in the table of
  `Media.Element` goes into `gst_element_factory_create_with_properties`
  (1.20; CI has 1.24) -- the refusal of `Set` had pointed there while the
  table refused it the same way. A signal's parameter types carry
  `G_SIGNAL_TYPE_STATIC_SCOPE` when declared with it (typefind's
  `have-type`), and are masked before they are compared.
- **`gst_util_set_object_arg` silently returns**, and `gst_value_serialize` is
  not its inverse (caps come back escaped in the launch form, flags as the
  long name). `Set`/`Get` borrow the *syntax* (`ball`, `tcp+udp`, `30/1`) and
  build the text themselves; every conversion it cannot make is a sentence.
- **`level` has no signal left, only messages -- and `element` is the ninth
  bus kind because of it.** Measured on GStreamer 1.28: `gst-inspect-1.0
  level` lists no signals and `gi` answers "unknown signal name: level";
  `decodebin`'s signals still print, so it is the element, not the tool. The
  numbers arrive the modern way instead -- one `element` message per
  `interval` (100 ms by default), `rms`/`peak`/`decay` as `GValueArray` of dB
  doubles, one per channel. `Bus.On` dispatched eight message kinds and
  dropped `element` at its `default: return`; the recorder's meter is why it
  is the ninth, `handler(name, fields)` with the structure's name and its
  fields as one object -- numbers, strings, booleans and arrays of numbers,
  and a field this surface carries no value for is left out rather than
  guessed at. `tests/media`'s `levels` scenario holds it to two channels'
  peaks in dB.


## Desktop integration

- **A `.desktop` entry's `Exec` is quoted twice, and the outer layer is not the
  one you think.** `Exec` has a quoting of its own -- every argument in double
  quotes, with `"`, `` ` ``, `$` and `\` escaped inside them, and `%` doubled
  because a single one is the format's field-code marker (`%f`, `%u`) -- and all
  of *that* is a string value in a key file, which escapes the backslashes again
  on the way out. So the file a hand-written command produces is either rejected
  by `desktop-file-validate` (`contains a non-escaped character '$' in a quote,
  but it should be escaped with two backslashes`) or accepted and splits the
  argument in two at launch. **The parser to test against is `gio launch`**, a
  real `GDesktopAppInfo` and the same road a menu takes; `desktop-file-validate`
  is the other half, and it only checks the file. `Desktop.Entries.Exec(argv)`
  is that whole job, and `tests/widgets` (`Desktop`) installs an entry, launches
  it with `gio` and reads the arguments back -- space, `%`, `"`, `$`, `\` and an
  accent in one command. Writing the string by hand in JS is the regression to
  watch for, and it is the build-another-parser mistake this file keeps warning
  about.
- **A generated menu entry is a file a test can leave in somebody's menu.**
  `tests/ide`'s `apps` phase installs a real `.desktop` under
  `$XDG_DATA_HOME/applications`, which without care is the developer's own menu
  -- surviving the run as an entry for a project in `/tmp`. The runner points
  `XDG_DATA_HOME` at a scratch directory (`bta-suite-<pid>/data`) for exactly
  this, and the test still removes what it installs, because `tests/try.sh` has
  no runner to isolate it.
- **`GKeyFile` drops the translations the desktop does not speak, unless it is
  told not to.** Without `G_KEY_FILE_KEEP_TRANSLATIONS`, a `Key[locale]` is
  kept only when the locale is one of `g_get_language_names()`'s -- so
  `Name[es]` is a key on a desktop set to Spanish and is **not** on one set to
  English, and `Desktop.Entries.Read` lost every translation on CI's `C` locale
  while passing in `es_AR` here. A read-and-write-back is how a file loses what
  nobody looked at, and this one is invisible where it is written: any
  `GKeyFile` a program means to write back loads with the flag. Caught by the
  first CI run that got as far as the suite (`tests/widgets`'s `Desktop`).

## Keyring: the vault, and what it does not promise

`Keyring.Available`, `Store`, `Lookup` and `Delete`, in `bta_keyring.c`, over
libsecret -- the system's secret store, so a token is not a plain file. What bit
and what to know:
- **`Available` is the build and not the machine, and the API says so by folding
  the two failures into one answer.** A runtime linked against libsecret on a
  headless server has `Available === true` and no service on the bus, so nothing
  stored and no vault to ask are both `null`/`false`. A caller that keeps a
  fallback does not have to tell them apart; a caller that cares asks
  `Available` first and gets the build's answer, which is all it can know.
- **The callbacks take one value, on purpose.** `Store`/`Delete` answer
  `cb(ok)` and `Lookup` `cb(value)`, so there is no error protocol to document
  and a libsecret `GError` is folded into the value. The alternative -- two
  callbacks like `Http`, or `(value, error)` -- is more surface for an
  application whose next move is the same either way: fall back.
- **The schema is made with `secret_schema_new`, not a static initializer.** A
  written-out `SecretSchema` warns on the library's private tail (`reserved` and
  seven `reservedN`) with `-Wmissing-field-initializers`, and initializing those
  fields by hand is a build that breaks the day libsecret grows one. It is
  created once at init and released in cleanup, after the calls are cancelled.
- **A `main` project waits for the answer and a worker cannot ask.** The vault
  is not a window, so `bta_keyring_pending` is summed into the console loop like
  `bta_http_pending`; a `Task` does not install the global at all, because the
  callback belongs to the main loop -- the `Http` bargain, not the sqlite one.
- **The suite never writes to the real vault.** `testKeyring` forks on
  `Available`: without libsecret the three verbs refuse naming the package (the
  `no-libsecret` CI job is that build), and with it only the argument refusals
  are asserted, which touch no bus. A test secret in the developer's keyring is
  a side effect the suite has no business causing, and a locked collection would
  make the answer depend on the machine. The real round trip is a by-hand check
  (`secret-tool`'s collection here is locked, which is exactly the failure the
  application's fallback exists for).

## Notification: the suite shares the user's session bus

**`Notification.Send` from `tests/widgets`' own process would put a toast on the
developer's desktop.** The runner moves `XDG_DATA_HOME` and the display, and not
the D-Bus session, and a notification daemon is listening on it -- the same shape
as every "the suite opened a window over somebody's work" note here, from a
direction nobody had a rule for. So `testNotification` only calls what refuses
before it sends, and the sending is a **child on a private bus**
(`dbus-run-session --config-file=…`) watched with `dbus-monitor`, which sees the
`Notify` call whether or not anyone answers.

**The configuration is the point, and a bare `dbus-run-session` is not safe.** It
uses the default service directories, so the private bus *activated the system's
real services*: `xdg-desktop-portal`, the desktop's notification daemon and **the
desktop's settings daemon** -- seen in the monitor's log as "Activating service
name=…" lines, on a spike that was only meant to look. A `<busconfig>`
with a `<listen>`, an `<auth>` and one permissive `<policy>` and **no `<servicedir>`**
makes the bus empty; calls to a name nobody owns fail and the monitor still sees
them. Do that for anything that needs a bus.

Three more, measured with it:
- **A project with no `id` sends nothing and is told nothing.** `gtk_application_new
  (NULL, …)` is what an id-less project gets, and `g_application_send_notification`
  answers with a `GLib-GIO-CRITICAL` assertion: five calls, zero on the bus. The
  verb refuses, naming `project.json`'s `id`.
- **`High` and `Normal` are the same urgency on a freedesktop daemon** (hint byte
  1 for both; `Low` is 0 and `Urgent` is 2), because the protocol has three levels.
  The four stay, since a portal tells them apart, and the page says so. The test
  asserts Normal, Low and Urgent and deliberately not High -- asserting it would
  pin a GLib version's mapping.
- **A same-`Id` replace and a `Withdraw` cannot be seen on a bus with no daemon**:
  GLib tracks the daemon's reply id and there is no reply, so `replaces_id` is 0 and
  no `CloseNotification` is sent. Both are by-hand checks on a real desktop.
- **"Is the user looking at this window" is `Form.Focused`, and nobody had said so.**
  `Widget.Focused` is `gtk_event_controller_focus_contains_focus`, which GTK4 turns
  `false` when the toplevel stops being the active window. Measured on an `Xvfb` with
  a window manager and two windows: `Focused=true` on the one activated, `false` on the other,
  swapping with `xdotool windowactivate`. **Without a window manager it never turns
  false** (nothing takes the focus away), so a headless run of `examples/backup`
  correctly sends nothing -- seeing its notification needs the window manager, a
  second window brought forward mid-run, and the private bus above. The first draft
  asked for a `Form.Active` that does not exist; the lesson is the usual one, that
  the missing feature was a missing sentence, now in the member's own comment.
  `examples/backup` and `examples/webhook` are the callers for `Gzip`/`Notification`
  and for `Random`/`Hmac`/`Verify`; the second is a test (`ExampleWebhook`), the first
  is by hand because a window does not end.

No click that calls back, on purpose: it would be a tenth async job shape, held by
something the desktop keeps past the window that sent it. The title and body are
not translated by `Send`; the caller wraps them in `Locale.Text`.
