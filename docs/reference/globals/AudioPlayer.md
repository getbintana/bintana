# AudioPlayer

Sound with no window.

An alarm cue, a stream listened to, the audio half of anything
[`Video`](../widgets/Video.md) shows. One playbin3 per player with the video
branch switched off and never decoded, so **several may play at once**.

```js
const cue = new AudioPlayer();
cue.Uri = "done.ogg";
cue.OnEnded = () => print("ding");
cue.Play();
```

## Every member

| | | |
|---|---|---|
| `new AudioPlayer()` | a player of its own; takes no arguments | [playing](#playing) |
| `Buffering` (ro) | how full the buffer is, `0`…`100` | [streams](#streams) |
| `Duration` (ro) | seconds long, `-1` while unknown | [where it is](#where-it-is) |
| `Latency` | ms the RTSP jitterbuffer may hold. Default `2000` | [streams](#streams) |
| `Loop` | reseek instead of ending | [playing](#playing) |
| `Muted` | silence without touching `Volume` | [sound](#sound) |
| `OnEnded` | assign `() => …`; `null` takes it off | [when it ends or fails](#when-it-ends-or-fails) |
| `OnError` | assign `(message, kind) => …` | [when it ends or fails](#when-it-ends-or-fails) |
| `Password` | the RTSP secret. **Write-only** | [streams](#streams) |
| `Pause()` | holds the position | [playing](#playing) |
| `Play()` | plays | [playing](#playing) |
| `Playing` (ro) | whether it is going | [playing](#playing) |
| `Position` (ro) | seconds in, `0` when unknown | [where it is](#where-it-is) |
| `Seek(seconds)` | jumps there | [where it is](#where-it-is) |
| `Seekable` (ro) | whether `Seek` has anything to work on | [where it is](#where-it-is) |
| `Stop()` | parks it | [playing](#playing) |
| `Uri` | what to play | [playing](#playing) |
| `User` | RTSP digest identity | [streams](#streams) |
| `Volume` | `0`…`1`. Default `1` | [sound](#sound) |

## Playing

| | |
|---|---|
| `Uri` | a URI (`file://`, `http(s)://`, `rtsp://`) **or a plain local path**, which is turned into one |
| `Play()` | plays; replays from the top after it ended |
| `Pause()` | holds the position |
| `Stop()` | parks it: no state, the position forgotten |
| `Playing` (ro) | what `Play` asked for, until `Pause`, `Stop`, the end or an error — **not a sample of the pipeline** |
| `Loop` | reseek instead of ending. A live stream cannot seek, so it ends anyway |

**A cue is a player you keep**, not one you make per sound: making one per beep
builds a pipeline per beep. Several players at once is the supported shape —
music under an alarm, two streams compared.

## Sound

| | |
|---|---|
| `Volume` | `0`…`1`. Default `1` |
| `Muted` | silence without touching `Volume`, so unmuting comes back to where it was |

## Where it is

| | |
|---|---|
| `Position` (ro) | seconds in, `0` when unknown — which includes playing live |
| `Duration` (ro) | seconds long, `-1` while unknown — which is always, on a live stream |
| `Seekable` (ro) | whether `Seek` has anything to work on |
| `Seek(seconds)` | jumps there; refused where there is nowhere to go |

A position bar is a [`Timer`](Timer.md) reading `Position`, as it is for a video.

## Streams

| | |
|---|---|
| `Buffering` (ro) | how full the buffer is, `0`…`100`; `100` is nothing to wait for, less is a stream refilling |
| `Latency` | ms the RTSP jitterbuffer may hold. Default `2000`. Read when the source is built, so a change lands on the next `Play` from a stopped player |
| `User` | RTSP digest identity; `""` for none |
| `Password` | the secret beside it. **Write-only**: it reads back `""`, so it is never written down anywhere |

## When it ends or fails

| | |
|---|---|
| `OnEnded` | assign `() => …`; `null` takes it off. **Anything else is refused where it is assigned**, rather than silently never called |
| `OnError` | assign `(message, kind) => …`; the same rule. `kind` is `NotFound`, `NotAuthorized`, `Unreachable`, `Decode` or `Error`, as a [`Video`](../widgets/Video.md)'s is |

Handlers here are **assigned properties and not events**, because a player is not
a widget: it has no name on a form for an event to be dispatched to.

## What goes wrong

- **Nothing was heard.** No `Uri`, this build has no GStreamer, or the player was
  a local that went out of scope — keep it.
- **A beep per second built a pipeline per second.** Keep one player and
  `Play()` it again.
- **`OnEnded` was assigned something that is not a function.** Refused where
  assigned; that is the point.
- **`Seek` was refused.** Live.

## See also

[`Video`](../widgets/Video.md) · [`Timer`](Timer.md) ·
[`examples/video`](../../../examples/video)
