# ISSUE: no audio or video

## What the application needed

A confirmation sound, a video shown in a window, a media viewer with play and
pause. The concrete case was an alarm application that had to make a sound, and a
viewer that had to show a clip it had just recorded.

## What I wrote instead

Nothing in-process. Video is handed to an external player with
`Exec(["xdg-open", file])` — outside the window, outside the application's
control — and a sound has no path at all, not even a beep.

## The code I wish I could have written

```js
Media.Play("done.ogg")                     // a sound, no window
// or a widget:
//   Video with `File`, `Loop`, and Play()/Pause()
```

## Why the existing words do not cover it

`Picture` and `Image` are still images. `Exec` / `File.Open` hand the file to
another program. No widget plays audio or video, and there is no sound primitive.

## Prior art

.NET `SoundPlayer` and `MediaElement`. VB6 `MMControl`. Gambas `MediaView` and
`Sound`. GTK4 `GtkVideo`, `GtkMediaFile` and `GtkMediaControls`, plus
`gdk_display_beep` for a bare beep.

## How much it mattered

It works, but a part of it is noticeably worse: anything audible or moving is
delegated to another application, and a sound cue is impossible.
