# Third-party notices

Bintana itself is MIT; see [`LICENSE`](LICENSE). The runtime embeds QuickJS,
and the Windows download also carries third-party binaries. This file says
what those are, what their licenses ask for, and **what this project does and
does not yet do about it**.

## QuickJS

`vendor/quickjs` is quickjs-ng, MIT. The full notice is installed as
`LICENSE-QuickJS` beside `LICENSE`, and under `share/licenses/bintana`, so it
travels with every binary that embeds the engine.

## Linux and Flatpak

The Linux tarball and the Flatpak BaseApp link against the distribution's
libraries (and, in a Flatpak, the GNOME runtime's): GTK, GtkSourceView,
GStreamer, poppler and the rest. Those libraries are **not copied** into the
artifact; their licenses and source belong to the distribution or the runtime.

## The Windows portable zip and the Windows setup

**This project distributes these binaries.** The `windows` job in
`.github/workflows/ci.yml` builds against MSYS2 UCRT64 packages, and a tag
attaches the zip and the setup to the GitHub release. Whoever passes a copy on
redistributes the same binaries.

How the tree is filled:

- `tools/windows-portable.sh` copies the DLLs the executables import, plus the
  data GTK, GStreamer and poppler open at run time. The setup built by
  `tools/pack.sh --nsis` installs that same tree.
- **Every GStreamer plugin MSYS2 installed is copied, not only the ones
  Bintana uses**, with the DLLs they import. The job installs
  gst-plugins-base, -good, -bad, gst-libav and gst-plugins-rs, so the bundle
  carries FFmpeg, the DVD libraries and the FDK AAC encoder even though no
  Bintana API reaches them.

What travels with the binaries:

- The license text of every package in the build environment, copied to
  `share/licenses/bintana/msys2/<package>/` **where MSYS2 ships one**. A
  package without a license directory has no text there.
- `share/licenses/bintana/MSYS2-PACKAGES.md`, naming those directories and
  the exact version of every UCRT64 package installed when the tree was built
  (a superset of what the bundle holds).

What does **not** travel with them:

- **The source.** A release attaches no source of the third-party components
  and makes no written offer for it. The source of each version is published
  by MSYS2 (<https://repo.msys2.org/mingw/sources/>, the recipe at
  <https://github.com/msys2/MINGW-packages>) and by each upstream project, but
  this project does not host it or guarantee it stays there. For the GPL and
  LGPL components that pointer alone may not be what their licenses ask of a
  distributor, and for libfdk-aac it is not: its license asks for the source to
  accompany the binary.

The components, and what each license asks:

| component | license | in the bundle because | text in `msys2/` |
|---|---|---|---|
| GTK 4, GtkSourceView 5, GLib, GIO, Pango, Cairo | LGPL-2.1-or-later | every window | `gtk4`, `gtksourceview5`, `glib2`, `pango`, `cairo` |
| GStreamer and its plugins | LGPL-2.0-or-later, some plugins under other licenses | `Video`, `AudioPlayer`, `Media` | the Rust plugins' in `gst-plugins-rs`; MSYS2 packages none for the C core, whose text and source are at <https://gstreamer.freedesktop.org/> |
| poppler, poppler-glib | GPL-2.0-or-later | `PdfDocument`; linked by `bintana-gui.exe` | MSYS2 packages none; text and source at <https://poppler.freedesktop.org/> |
| FFmpeg | LGPL-2.1-or-later, GPL with the GPL parts MSYS2's build enables | gst-libav, copied with the plugins; decoders for patented codecs | where MSYS2 packages one |
| libdvdread, libdvdnav, libdvdcss | GPL-2.0-or-later | gst-plugins-bad's DVD plugin, copied with the plugins | `libdvdread`, `libdvdnav`, `libdvdcss` |
| libfdk-aac | Fraunhofer FDK AAC license (not GPL-compatible; AAC is patented) | gst-plugins-bad's `fdkaac`, copied with the plugins | `libfdk-aac` |
| OpenSSL | Apache-2.0 | a dependency of the bundled DLLs | `openssl` |
| libvterm | MIT | `Terminal` | in `msys2/` |
| Adwaita and AdwaitaLegacy icon themes | CC-BY-SA-3.0 | icons | attribution: GNOME Project, <https://www.gnome.org> |
| NSIS, when the compiler is bundled | zlib/libpng | `lib/package` building a setup | its `COPYING` travels inside the NSIS directory |
| IANA time zone database (`share/zoneinfo`) | public domain | `Zone`: Windows has no copy of its own | `tzdata`, if MSYS2 packages one; the data itself carries no license terms |

And one table in the runtime's own source, on every platform:

- **`runtime/src/bta_zone.c`'s `WINDOWS_ZONES`**, the registry's zone names
  to IANA ids, is taken from CLDR's `windowsZones.xml` (Unicode License v3,
  <https://www.unicode.org/license.txt>): 142 rows, compiled into the Windows
  build only. The license asks for its notice to accompany copies of the data;
  this paragraph and the comment above the table are that notice.

Bintana's own MIT license does not relicense any of them. A binary that links
poppler is distributed under the GPL's terms as a whole, which MIT permits;
Bintana's own source is public at <https://github.com/getbintana/bintana>.
