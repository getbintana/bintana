# ISSUE: a Video cannot say whether it can play

## What the application needed

The IDE's palette offers a `Video` on a build that cannot play one. Two
concrete cases, and both happen in this tree:

- a runtime built **without GStreamer** — the CMake step says so in as many
  words (`Video and AudioPlayer will say so when called`), and a build without
  it is legitimate by design; and
- a build **with GStreamer and without `gtk4paintablesink`**, the sink that
  puts the frames in a `GtkPicture` — which is the shape CI runs when
  `gstreamer1.0-gtk4` is not packaged.

In both, a user drags a Video onto a form, draws around it, and learns only
when the program runs and `Play()` throws that this machine could never have
played it. The designer offered a control it could not keep.

`Terminal` is the other widget with an optional engine and has the same gap,
so whatever answers this should answer for both. `Video` is the harder of the
two, and the reason is worth stating: `BTA_HAVE_GST` would answer half of it,
and the build with GStreamer and no `gtk4paintablesink` is the other half --
so the answer is not always a compile-time constant.

## What I wrote instead

Nothing. `Widget.Types()` still lists `Video`, the palette still draws its
button, and a `.form` naming one still loads — the properties answer on
purpose, so the designer and the serialiser do not depend on the engine. The
only refusal is the sentence `Play()` throws, which is right for a running
application and too late for a palette.

## The code I wish I could have written

```js
if (!new Video().Available) { /* do not offer it */ }
```

or the same question asked of the class, which is what a palette would rather
do than build a control to ask about it:

```js
Widget.Available("Video")
```

Either spelling would do. What matters is that it can be asked **before** a
control is placed, and that `Video` can answer it on a build with GStreamer
and no sink -- where the honest answer depends on the plugin registry, whose
first read is 573 ms cold.

## Why the existing words do not cover it

`Widget.Types()` says which classes the runtime has, not which can work on this
build; `Widget.New("Video")` builds one either way. `Application.HasCommand`
and `Application.HasIcon` are capabilities of the system, not of a control.
`PropertyOptions` and `TextProperties` answer a different question about a
class.

The only way to know today is to call `Play()` and catch, which starts a
pipeline to answer a question a palette asks before anything is drawn — and on
a build with GStreamer and no sink, the answer depends on the plugin registry,
whose first read is 573 ms cold.

## Prior art

VB6 and Gambas show the components of that installation: an absent one has no
button. .NET's toolbox filters by installed components and designers. GTK4 has
no toolbox to compare against.

## How much it mattered

It works, and a part of it is noticeably worse: the designer offers a control
that cannot run on this build, and the only warning is a dialog at `Play` time.
