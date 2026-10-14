# Probe: what a file is, and why it is not a verb on `File`

`Probe.Image(path) -> { Width, Height }` reads a picture's header with **no
widget and no display**, which is the whole of it. The prior art agrees on the
name and on the operation, and that is why it is `Probe`:
- **`ffprobe`, `exiftool`, ImageMagick's `identify`** -- a probe reads the header
  and says what the thing is without decoding it;
- **Gambas's `ImageStat`** (`gb.image`) -- "returns information about a specific
  image", *not creatable*, used as a static, with `Width`, `Height`, `Depth`,
  `Type`, `Path`. The language closest to this one puts it on an object, not on
  a file verb;
- **Go's `image.DecodeConfig`** and **Qt's `QImageReader::size`** -- both read
  headers only, both on the image side of the library;
- **.NET has nothing**, and that is the evidence: `System.Drawing.Image.FromFile`
  decodes the whole picture, and "the size without loading it" is a Stack Overflow
  question whose accepted answer is a hand-written JPEG parser or a third-party
  package. Where .NET *has* an image object, the size is on it.

**`File.ImageSize` was written first and is the wrong name**, and the argument
against it is the one worth keeping: `File` is for working *on* a file (`Load`,
`Save`, `Info`, `Hash`, `Watch`), and adding a question about a *picture* to the
object that moves bytes around is a category error. It would also be a second
answer for a word: **`File.Info` already answers `Type`**, as a MIME type, so a
`File.ImageSize` puts two answers for one name in one namespace, which is how
`AddNode` came to be documented under `Container` and had to be renamed to `Add`.
`Info` was the other candidate and is refused for that reason; `Meta` is the
standard term for a media file's descriptive data but in a runtime that has
`Record` and `Field` a bare `Meta` already means *the data of a row*.

**The namespace is the design.** `Probe.Image`, and a verb per *kind* of thing
when something needs one -- `Probe.Audio`, `Probe.Video`, `Probe.Font` -- with
deliberately **no `Probe.File`**, because a file's size and time are already
`File.Info`'s and asking twice is how two answers for one word happen. There is
no image *object* in this runtime: `Image` and `Picture` are both controls, and a
decoded picture lives as a `GdkTexture` in the widget's qdata with nothing handing
it out. `Probe.Image` is the measurement without that object, and an object is a
separate piece of work (a new `.c`, five registrations, `gc_mark` and a
finaliser) whose payoff is the decode cache rather than the size.

**It reads the same set of files a `Picture` draws**, because
`gdk_pixbuf_get_file_info` is the header reader and
`gdk_texture_new_from_filename` -- what `Picture.File` decodes with -- is built
on the same loaders. **Which files those are is the machine's answer and not
this runtime's**, and it was first written down wrong: "an `.svg` is `null`
here", stated in the source, here and in `api.json`, and measured false the
first time an application used it -- on Fedora 44 GdkPixbuf reads through
glycin, which has an SVG loader, so `Probe.Image` and `Picture` both answer an
SVG's declared size (`300x100` for `viewBox="0 0 300 100"`). Where no loader
reads SVG, both answer nothing. The property that holds is the agreement, not
the list. **`null` for both "not a picture" and
"not there"**, one answer for one question and the same one `File.Info` gives; a
path that is not text is still a **refusal** through `bta_file_path`, because
`Probe.Image(undefined)` must not quietly probe a file called `./undefined`.

It is `runtime/src/bta_probe.c` and not part of `bta_paint.c` or `bta_sys.c`
because it will grow into file statistics and audio metadata, which have nothing
to do with drawing -- and `bta_sys.c` is already 4 483 lines carrying a different
promise ("verbs that work *on* files", which is the objection above). **A worker
installs it too**, since it is a header read and a dictionary: a report sizing a
logo on a thread is the caller a widget could not have served anyway. A new global
is five places -- the `.c`, its `CMakeLists.txt` line, its init in `bta.h`, and
the two `install` roads, `bta_runtime.c` **and** `bta_task.c`.
