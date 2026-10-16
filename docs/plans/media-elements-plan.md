# Advanced GStreamer elements: build, link, configure, subscribe

**Built: both stages** — `Media.Element`, `Element`, `Pad` and `Bus` over
GStreamer, with `Eos` (which the first recorder example asked for) and `On`
(whose pad-added test needed a synchronous delivery and a keepalive — both
measured, both written into [`media-desktop.md`](../agents/media-desktop.md)).
The tool is `tests/media.sh`, and a `no-gst` CI job runs its other branch.
What is left of this file is the deferrals with their triggers, below.

Asked for by the owner on 2026-10-16, in the words of the surface it wants:
*build elements by name, connect, configure and subscribe*. The caller that
argued for it is the one [`media-desktop.md`](../agents/media-desktop.md)
already keeps: a `playbin` covers a URI to a screen, and a program that must
choose its own elements, decode once and send the stream two ways, or reach a
property a playbin hides has no words without this.

## What is there, counted

- `runtime/src/bta_media.c` (1867 lines) is the whole media surface: `Video`
  and `AudioPlayer`, one `playbin3` each, digest credentials through
  `source-setup`, and a bus watch that maps five messages (`EOS`, `ERROR`,
  `BUFFERING`, `CLOCK_LOST`, `WARNING`) onto widget events. Everything a
  playbin does, they do; everything else is unreachable, because the only
  element a program can influence is the one the playbin builds for it.
- **The four verbs have no surface.** `gst-inspect-1.0` on the machine this was
  measured on (GStreamer 1.28.7, Fedora) lists 1168 elements among 1359
  features in 239 plugins — `rtspsrc` (45 properties; a src pad named
  `stream_%u`, there *Sometimes*), `tee` (src pads *On request*), `decodebin`
  (`src_%u`, *Sometimes*), `gtk4paintablesink` (19 properties). A Bintana
  program can name none of them.
- The three traps the players were paid for are the traps of any pipeline, and
  this design is mostly their shape: **a playbin owns the sink it was given**;
  **teardown waits for NULL**; **never ask a pipeline whether it is playing**.

## What was measured

Probes in C against 1.28.7 (in `/tmp`, never kept), `gst-inspect-1.0`'s pages,
and the source where a behaviour had to be read rather than run:

- `gst_element_factory_make("videotestsrc", NULL)` builds by name and GStreamer
  names it (`videotestsrc0`, `tee0`); the instance name is an ordinary writable
  property (`name`).
- **`gst_util_set_object_arg` — the function gst-launch's property syntax is
  built on — silently returns** when the property does not exist or the text
  does not convert ("Note that this function silently returns…", its own
  documentation; measured as a no-op for a bad name and a bad value, with a
  good set after each proving nothing landed). Its *syntax* is the one to
  borrow (`ball`, `3`, `true`, `tcp`, `tcp+udp` — all measured accepted); its
  silence is not.
- The reading road, `gst_value_serialize`, is not the writing road's inverse in
  the two places that matter: caps come back `"video/x-raw\,\ format\=\(string\)RGB"`
  — the launch form, every `,` and `=` escaped — and flags as
  `GST_RTSP_LOWER_TRANS_TCP`, the long name, where writing takes the nick
  `tcp`. Scalars, enums and fractions do round-trip (`3`, `true`, `ball`,
  `30/1`).
- `gst_element_link` **requests pads on demand**: linking `tee` to two queues
  produced `src_0` and `src_1` (a third from `gst_element_request_pad`, marked
  deprecated in favour of `gst_element_request_pad_simple`). It returns `FALSE`
  on an element whose pads are *Sometimes* (measured: `rtspsrc ! fakesink`) —
  which is what `pad-added` is for.
- **Adding an element to a bin unlinks its pads** — the documentation of
  `gst_bin_add` says it in words: "If the element's pads are linked to other
  pads, the pads will be unlinked before the element is added to the bin". So
  the order is `Add` first and `Link` after; a link made before the add is
  thrown away in silence.
- **A child added to a `PLAYING` pipeline stays in `NULL`** — measured right
  after `gst_bin_add`, and reaching `PLAYING` only after
  `gst_element_sync_state_with_parent` with data linked to it. The same
  documentation says the caller has to do it: "The bin or pipeline will not
  take care of this for you."
- **`gst_element_get_bus` on a child answers the bin's internal child bus, not
  the application's.** `gst_element_get_bus(pipeline)` and
  `gst_pipeline_get_bus(pipeline)` are one object (measured); a child's is a
  different one (`gst_bin_init` builds it, `gst_bin_add_func` distributes it),
  and a timed pop on it fails the way a bus with no poll does — while the
  application's bus answered `state-changed`. A child has no road to the
  messages; `Element.Bus` has to walk up to the pipeline.
- `pad-added` "will usually be emitted from the context of the streaming
  thread" (its own documentation) — the note `bta_media.c` already obeys for
  `source-setup`. `g_signal_query` on a built `decodebin` says `pad-added`
  returns nothing and carries one `GstPad`; `autoplug-continue` returns
  `gboolean` — one of the signals that *answer* something, which no word of
  this surface carries back.
- A `tee` with two branches and no `queue` per branch never finishes:
  `gst-launch` under a timeout hung identically (rc=124) and returned 0 with
  the two queues in. A fact about graphs, not about this API — one line in the
  documentation of `Link`.
- `gst_element_get_static_pad` "only retrieves already-existing (i.e.
  'static') pads" — so asking for a pad that has not appeared is a question
  with `null` for an answer, not an error.
- **A pipeline set to `NULL` without EOS leaves a writer's placeholders in
  place**: measured — a `wavenc` of one second wrote 360 kB whose header
  fields still said ~2 GiB (`0x7FFFFFE4`) in both sizes; the same run with an
  end-of-stream event first has the exact sizes. `gst-launch-1.0` carries `-e`
  for this reason ("force EOS on sources before shutting the pipeline down",
  so muxers write readable files), and the writers that need it are not just
  WAV's.
- **A signal delivered only asynchronously loses `pad-added`**, measured in
  four C variants and then in the runtime: the emitting thread pushes before
  the main loop gets there and `wavparse` stops with "streaming stopped,
  reason not-linked". The fix is the shape of the delivery below — inline on
  the main thread, otherwise queued *and waited for*, capped. Two more
  measurements came with it: two `gst_bus_add_watch` calls on one bus **split
  the messages** between them (a `Bus.On("eos")` missed it every other run,
  which is why one watch per bus is shared by everything), and a subscription
  must hold its element alive, because a `decodebin` in a local variable is
  collected — subscription and all — the moment the function that built the
  graph returns. The traps are written down in
  [`media-desktop.md`](../agents/media-desktop.md).

## The surface

```text
Media.Available                         -> boolean
Media.Element(type, [props])            -> Element

Element.Add(child)                      -> Element
Element.Link(other, [from], [to])       -> Element
Element.Pad(name)                       -> Pad | null
Element.Set(name, value)
Element.Get(name)                       -> value
Element.State                           (property)
Element.Eos()
Element.On(signal, handler)             -> Element
Element.Bus                             -> Bus | null

Pad.Name                                -> string
Pad.Caps                                -> string
Pad.Link(target)                        -> Pad

Bus.On(type, handler)                   -> Bus
```

The camera, in full — the program `media-desktop.md` says needs a pipeline of
its own:

```js
const pipe  = Media.Element("pipeline", { name: "cam1" });
const src   = pipe.Add(Media.Element("rtspsrc", { location: url,
                                                  "user-id": user,
                                                  "user-pw": pass,
                                                  protocols: "tcp" }));
const depay = pipe.Add(Media.Element("rtph264depay"));
const dec   = pipe.Add(Media.Element("avdec_h264"));
const sink  = pipe.Add(Media.Element("fakesink"));

src.On("pad-added", pad => {
    if (pad.Caps.startsWith("application/x-rtp"))
        pad.Link(depay);
});
depay.Link(dec).Link(sink);

pipe.Bus.On("error", (message, kind) => { /* NotAuthorized, Unreachable, … */ });
pipe.Bus.On("eos", () => { pipe.State = "Null"; });
pipe.State = "Playing";
```

### Build: `Media.Element`

`Media.Element(type, [props])` is `gst_element_factory_make`, with a refusal
when the name is not a type this installation has: *"there is no element type
'rtspsrc': its plugin is not installed, or the name is misspelled —
`gst-inspect-1.0` lists what is here"*. The optional table is applied through
`Set`, property by property, so a bad name or a bad value refuses there; the
half-built element is freed on the way out.

Nothing else is asked of the factory: no kind check, no plugin list, no
`Video`-style "is it playable" (that question belongs to the player). The
instance name is the `name` property, so `Media.Element("pipeline", { name:
"cam1" })` is the whole of it.

### Connect: `Add`, `Link`, `Pad`

- **`Element.Add(child)`** takes a child into a bin or pipeline (`gst_bin_add`)
  and answers the child, so `pipe.Add(Media.Element(…))` reads left to right
  and the child is what the rest of the line configures. It refuses a target
  that is not a container, a child that already has a parent (naming it), and
  a loop (a bin into itself). When the bin is not in `NULL` it follows with
  `gst_element_sync_state_with_parent`, because measured silence here means a
  hot-added branch that never starts — the documentation leaves that to the
  caller, and every program forgets it exactly once. The add itself unlinks the
  child's pads (measured above), which is why `Add` comes before `Link` and why
  `Link` refuses across graphs (below).
- **`Element.Link(other, [from], [to])`** is `gst_element_link_pads`: no names
  means whatever pads meet, one name pins that side. It answers `other`, so a
  chain walks a graph (`depay.Link(dec).Link(sink)`). It refuses when the two
  elements do not share a non-NULL parent — "add both to the pipeline first" —
  since linking free elements works at the pad level and the `Add` that
  follows would silently unlink them. When `gst_element_link` fails and either
  side has a pad template that is *Sometimes*, the sentence adds the reason and
  the road: "…: rtspsrc's pads appear when the stream starts — subscribe to
  `pad-added` and link there". The member's documentation says the graph rule
  once: a `tee` with two branches needs a `queue` per branch or it never
  finishes.
- **`Element.Pad(name)`** answers the pad with that name **if it exists now**
  — `gst_element_get_static_pad` — and `null` when it does not. Asking is not a
  mistake; pads that will appear are announced by `pad-added`.
- **`Pad.Link(target)`** takes an `Element` (a compatible pad is found for it,
  `gst_element_get_compatible_pad`) or a `Pad` (linked directly), runs
  `gst_pad_link`, and answers the far pad. A failure names both pads and the
  reason GStreamer gives, in words: `WRONG_HIERARCHY` → "they are not in the
  same pipeline"; `WRONG_DIRECTION` → "both ask to be the source"; `NOFORMAT` →
  "their formats do not meet"; `REFUSED` → "the element refused it".

### Configure: `Set` and `Get`

`Element.Set(name, value)` and `Element.Get(name)` are `g_object_set_property`
/ `g_object_get_property` with the name looked up first
(`g_object_class_find_property`), so a name the element does not have refuses
with a sentence instead of the silence `gst_util_set_object_arg` measured above;
a read-only property refuses a `Set`, a write-only one a `Get`, and a
construct-only one says so (`Media.Element` applies its table after the make,
so a construct-only property is out of reach; the trigger is below).

The carried types — everything else refuses, naming the property and its type:

| the property is | `Set` takes | `Get` answers |
|---|---|---|
| `gboolean` | a boolean | a boolean |
| `gint`, `guint`, `gint64`, `guint64` | a number: whole, in range, and inside 2^53 for the 64-bit pair | a number |
| `gfloat`, `gdouble` | a number | a number |
| `string` | a string, with no NUL inside (refused, not cut short) | a string |
| an enum | the value's nick (`ball`, `smpte`) | the nick |
| flags | nicks joined by `+` (`tcp+udp`), the text gst-launch takes | the same, order GStreamer's |
| a fraction | `n/d` (`30/1`) | `n/d` |
| caps | caps text (`video/x-raw,format=RGB`) | caps text, `gst_caps_to_string`'s |

The text shapes are GStreamer's own — the enum nick, the flags list,
`gst_caps_from_string`'s input — and `Get` builds them with the class lookups
rather than `gst_value_serialize`, whose two deviations are measured above. A
refusal names the property and what it takes: *"pattern does not take 'foo' —
its values are ball, bar, smpte, …"*; *"num-buffers takes a number, not the
text 'three'"*; *"protocols takes flag names joined by +: udp, udp-mcast, tcp,
…"*.

An object-valued or boxed property refuses on the way out too: *"the value of
'paintable' is an object, and this surface does not carry one"*. That refusal
is the wall the picture road hits (below).

### Run and stop: `Element.State`, `Element.Eos`

`Element.State` is a property in the four words GStreamer uses, capitalised the
way this runtime's options are: `"Null"`, `"Ready"`, `"Paused"`, `"Playing"`
(any case on the way in). `Set` is `gst_element_set_state` and does not wait;
**`Get` answers what was asked of this element**, never a query —
`gst_element_get_state(…, 0)` is the trap `Video.Playing` was already designed
around. What the pipeline actually does is read from the bus: `state-changed`
and `async-done`.

A child that was never asked anything answers `"Null"` while it is, in fact,
playing along with its pipeline — the honest answer to the question the
property asks, and its documentation says so once.

**`Element.Eos()`** asks the graph to end the stream: it sends GStreamer's
end-of-stream event into the element — for a pipeline, every sink gets it — and
the bus answers `eos` once every writer has flushed. **A recorder asked for it
while the first example was written end to end**: the four members above leave
a written file with the placeholder sizes measured above, and `State = "Null"`
is a stop, not a finish. The recorder, whole:

```js
const pipe = Media.Element("pipeline");
const src  = pipe.Add(Media.Element("autoaudiosrc"));
const conv = pipe.Add(Media.Element("audioconvert"));
const enc  = pipe.Add(Media.Element("wavenc"));
const sink = pipe.Add(Media.Element("filesink", { location: path }));
src.Link(conv).Link(enc).Link(sink);

pipe.Bus.On("eos", () => { pipe.State = "Null"; });   /* the file is closed */
pipe.State = "Playing";                               /* …and it records… */
pipe.Eos();                                           /* stop: flush the header */
```

It refuses when GStreamer cannot take the event, naming the element. The
surface does not grow a `Stop()`: playback stops at `"Null"` — what the
players' own `Stop` does — and a writer stops at EOS, and only the program
knows which of the two it built.

### Subscribe: `Element.On`

`Element.On(name, handler)` subscribes to a GObject signal of that element;
`handler` as `null` takes it off, and a second call with the same name replaces
— one handler per name, the shape `On` already has on the widgets. The name is
GStreamer's, lower-case, as `gst-inspect-1.0` prints it (`pad-added`,
`no-more-pads`, `source-setup`): one vocabulary for the docs, the logs and the
program. The handler's answer is not read.

Subscribe-time refusals, each naming what it is:

- no such signal on this element's type (*"filesrc has no signal
  'pad-addedd'"*) — and when the name is a bus message (*eos*, *error*) the
  sentence says where those are answered (`Bus.On`);
- a signal whose query says it returns something (`autoplug-continue` answers a
  `gboolean`) — refused, because no word of this surface carries an answer
  back;
- a parameter the surface does not carry — refused, naming its type.

Handlers receive the arguments after the emitter: a `GstPad` as a `Pad`, a
`GstElement` as an `Element`, caps as text, plus strings, numbers and booleans.
Object arguments are **refs taken at emission**: what the handler is told about
is still there when it runs, even if GStreamer moved on. And **the handler runs
before the signal returns**: an emission already on the main thread runs it
inline, and one from GStreamer's threads queues it and waits — capped at two
seconds, after which it runs late. That is not politeness; an
asynchronous-only road was *measured* to lose `pad-added` (the source pushes
before the loop gets there, and `wavparse` stops with "not-linked"). The
two-second cap is what keeps a wedged main loop from becoming a wedged
pipeline.

### Subscribe: `Element.Bus` and `Bus.On`

`Element.Bus` answers the bus of the graph's pipeline — walking up to the first
`GST_IS_PIPELINE`, because the measured `gst_element_get_bus` answer for a
child is an internal bus nothing posts to the application — and `null` for an
element in no pipeline. `pipeline.Bus` is the same object the runtime's own
watch listens on: one watch per pipeline, owned by the wrapper, so EOS and
errors are seen even when the program subscribed to nothing.

`Bus.On(type, handler)` takes eight type names — GStreamer's message names,
lower-case — with the arguments below; `null` takes the handler off, a second
call replaces, and any other name refuses, listing the eight.

| type | the handler receives |
|---|---|
| `error`, `warning`, `info` | `(message, kind)` — `message` like `"rtspsrc0: it is not authorized"`, `kind` one of `NotFound`, `NotAuthorized`, `Unreachable`, `Decode`, `Error` |
| `eos` | nothing |
| `buffering` | `(percent)` |
| `state-changed` | `(name, state)` — which element, and the state it moved to |
| `clock-lost` | nothing |
| `async-done` | nothing |

The kind is the players' own `media_kind_for` and the reason is
`media_error_text`'s, so a camera that refuses a password reads the same on
both roads; the instance name is the part the players put their URI in.
`state-changed` fires for every element in the pipeline (GStreamer posts it
from each); a program that wants the pipeline's own move filters on `name`, or
subscribes to `async-done` and is told once. A `clock-lost` handler that does
nothing is a stutter the docs name once: GStreamer expects the pipeline to
PAUSED and back.

### `Media.Available`, and a Task

`Media.Available` is the build's answer, the `Xml`/`Keyring` property: true
when CMake found `gstreamer-1.0`. Whether *an element* exists is a per-name
question, refused by `Media.Element`.

In a runtime built without GStreamer the global is still installed: `Available`
is false, every verb refuses with the players' one sentence (`MEDIA_NO_GST`,
"this runtime was built without GStreamer, so there is no media to play…"), and
the classes are registered the same way — the api check and the class tables
answer with no engine, which is the rule `Video` already obeys.

A `Task` worker does not get `Media`: it joins `bta_http_init`/`bta_media_init`
in `bta_task.c`'s list of what a worker is not given, and the comment there
already says why — their callbacks are the main loop's.

## Lifetime and teardown

- **A wrapper owns a reference.** `Media.Element` sinks the factory's floating
  reference; a `Pad` or `Element` a handler is given is a reference the
  delivery took at emission; the finaliser unrefs. Two wrappers can point at
  one element (a signal argument and a held variable) and that is not a
  problem — the reference is what matters, and dropping them all drops the
  element.
- **A wrapper that was asked for a state outside `Null` stops its engine on the
  way out**: remove the watch, `gst_element_set_state(NULL)`, wait for the
  change with the players' cap (two seconds), then unref — the order
  `engine_teardown` documents, because unref while a state change is in flight
  finalises the pipeline under its own feet. A wrapper that was never asked
  just unrefs.
- **The `JSValue`s a wrapper holds** — its handlers, and the keepalive below —
  are marked in `gc_mark` and freed in the finaliser with `JS_FreeValueRT`; no
  `JSContext*` is carried beside them. A *queued delivery* holds its own dup of
  the handler and its own refs of the objects and is freed on every path; it
  joins the family the cleanup walks, so a runtime that goes with a delivery
  pending does not abort `JS_FreeRuntime`.
- **No JavaScript runs inside a GStreamer callback**, and the delivery that
  does run reads what it needs *before* the call: a handler that drops the last
  reference finalises the wrapper inside the call, which is exactly what
  `media_on_error` records ("the last line: it may finalise m").
- **A pipeline that plays keeps itself alive.** While `State` is `"Playing"`
  the wrapper holds a keepalive on its own JS object — the players' `m->self` —
  released when EOS or an error answers, and taken again by asking `"Playing"`
  again. **A subscription is the second claim on that life**: an element with
  a signal subscribed is held until the last one is unsubscribed, because a
  `decodebin` in a local variable is collected the moment the function that
  built the graph returns and takes its `pad-added` with it. That is what
  keeps a console program running while a pipeline plays, and it is counted
  where `bta_media_pending` counts the players: the console loop's sum gains
  the elements' half. The cleanup takes keepalives away first, stops engines
  second and frees the values last — the order `bta_media_cleanup` documents,
  because dropping the last reference inside the walk finalises the struct the
  walk is holding.

## What was considered and rejected

- **`gst_parse_launch`, a pipeline from a description**
  (`Media.Launch("rtspsrc location=… ! …")`): the tempting one-liner, and the
  wrong first road. The source a description builds cannot be reached before it
  starts — `source-setup` exists for exactly that, and the credentials this
  plan is half about are set there; a parse error comes back as a `GError`
  *and* possibly an element ("recoverable parsing error with a non-NULL
  element"); and there is nothing to subscribe to until it runs. Trigger: an
  application that wants a pipeline pasted from a manual.
- **`Set` onto `gst_util_set_object_arg`**: measured silence, and the refusals
  are the feature. Its syntax is borrowed; the call is not.
- **A generic GObject bridge** — boxed types, object properties, signals with
  returns, `notify::`: bigger than the four verbs, and the object-valued `Get`
  it would need is the one refusal with a named follow-up (below).
- **Deferred linking**: remembering a failed `Link` and retrying it on the
  first `pad-added`. It cannot tell two pads apart (`rtspsrc` can announce
  several) and it hides the decision the signal exists to make.
- **A class per element kind** (`Camera`, `Tee`), the road `Video`/
  `AudioPlayer` already walked once: it does not scale to 1168 names, and the
  names are what a program wants to type.

## What is deliberately not here

Each with the trigger that reopens it:

- **`Element.Remove`, releasing pads, `Unlink`** — taking one branch out of a
  running graph. `Remove` owes its own measurement (what the bin does to the
  child's state).
- **`Element.Request(template)`** for explicit request pads — `Link` already
  asks for one when it needs one; trigger: a graph with several request pads
  whose order the program has to choose.
- **The rest of the messages** — `tag`, `duration-changed`, `progress`,
  `stream-start`, `latency`, `qos`, and a subscription to all of them —
  trigger: a program that shows now-playing metadata or a progress bar from
  the bus.
- **Object-valued `Get`/`Set`** — the door a paintable comes through, and the
  next thing after this plan (below).
- **Events other than `Eos`** — seeking a graph of your own, flush, gap; the
  players' `Seek` answers the playback case; trigger: a caller that seeks (or
  otherwise sends events to) a pipeline it built.
- **Discovery** — `Media.Elements(filter)`, factory metadata, an element's
  property list for a palette — trigger: a program that offers a list rather
  than names an element.
- **Two handlers for one name** — `On` replaces; trigger: a case that wants two
  listeners.
- **`Media` in a `Task`** — the `Http`/`Keyring` bargain, stated above.
- **A construct-only property** — `Media.Element` applies its table after the
  make; trigger: a caller that needs one, and
  `gst_element_factory_make_with_properties` (1.20) is the answer.

## What this does not reach: a picture

The four verbs build a graph; they do not put one on a form.
`gtk4paintablesink`'s `paintable` is an object property and `Get` does not
carry objects, and `Picture` takes a file, bytes and a zoom — not a paintable.
Two roads, neither in this plan: a `Picture` (or `Video`) that can be handed
one — which is the object-valued `Get` above — or a sink whose `paintable` the
runtime itself wires into a widget. Trigger: the first camera wall whose frames
have to be *seen* on a form, which is the caller this plan keeps half an eye
on.

## Stages

**Stage 1 — the graph and the bus. Built.** `Media.Available`,
`Media.Element`, `Element`, `Pad`, `Bus`; the conversion table and the
refusals; `State`, `Eos`, `Add`, `Link`, `Pad`; `Bus.On`'s eight; the
keepalive and the pending count; the no-GStreamer half; the console tool and
its CI line. A program has a graph it already knows how to write statically,
running to EOS — the recorder in `examples/recorder` is the shape.

**Stage 2 — `On`. Built**, with two things the plan did not have and the
measurement demanded: the *synchronous* delivery (see above; the deferred one
loses `pad-added`) and the keepalive a subscription holds. `pad-added` over a
real `decodebin` is in `tests/media`, and `source-setup` rides the same road.

Then the picture road above, when a caller wants it.

## How it is tested

- **A new console tool**: `tests/media` (a `"main"` project, no GTK) with
  `tests/media.sh` in front, the `tests/bench` mold — console because none of
  this needs GTK and because one of the things to assert *is* the console loop.
  It runs headless with nothing arranged, so it joins `./tests/api.sh` as a
  step of CI's `test` job.
- Stage 1's assertions: the refusals (an unknown element, property, nick,
  number-on-string, `Get` of an object, `Add` into a non-bin, `Add` twice,
  `Link` across graphs, an unknown message type listed against the eight); the
  round trips for every row of the conversion table; a static `audiotestsrc
  num-buffers=3 ! fakesink` reaching EOS through `Bus.On("eos")` (and ending on
  its own — the `.sh`'s timeout is the failure when the accounting is wrong);
  the two-branch `tee`, each branch with its `queue` (without them it never
  finishes, measured); the recorder — `audiotestsrc ! wavenc ! filesink`,
  `Eos()` at the one-second mark, the `eos` handler setting `"Null"`, and the
  file read back with its header sizes exact (the assertion that goes red if
  `Eos` is skipped); a `filesrc` on a path that is not there, answering
  `error` with kind `NotFound`; a child added to a running pipeline, asserted
  through the `state-changed` it announces; and, under a build with no
  GStreamer, `Available` false and every verb refusing with the one sentence.
- Stage 2's: `decodebin` over the suite's own `win.wav`
  (`examples/tictactoe`), `pad-added` linking to an `audioconvert ! fakesink`
  branch, then EOS; a `playbin`'s `source-setup` handing over an `Element` that
  takes a `Set`.
- **GTK side**: nothing changes in `tests/widgets` — `Video` and `AudioPlayer`
  keep their engine and their tests. What the *declaration* is (every member's
  description, `api.json` current, the type tables answering by name) is
  `tests/api.sh`'s half.
- **A `no-gst` CI job**, the `no-libsecret` mold: a fake `pkg-config` that
  answers no for `gstreamer-1.0`, then `./tests/media.sh` and the suite. It is
  the sixth optional half CI does not have today, and the first time
  `tests/widgets`' own no-engine branch runs. If the job is not taken, the half
  is by hand and this file says so when it is built.

## Docs, in the same change

- **Here**: the member descriptions beside their C entries (the runtime's
  rule), `./tools/apijson.sh`, `./tests/api.sh` green; the measured traps — the
  silent `set_object_arg`, the caps escaping, the unlink-on-add, the late
  child, the child bus — into [`media-desktop.md`](../agents/media-desktop.md),
  where the area's traps live.
- **`bintana-docs`**: the `Media` page and the pages of `Element`, `Pad` and
  `Bus`, the `llm/library.md` section for the global, and its `check.sh`
  against this `api.json`.
- **`bintana-llm`**: the guide's chapter — a pipeline by hand, the camera, and
  the three traps an application author has to know (queues after a `tee`; pads
  that appear; a state that answers what was asked).
- **This directory's [README.md](README.md)**: the row below dies with the file
  when it is built, keeping only what the two tables and the traps say.
