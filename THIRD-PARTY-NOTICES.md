# Third-party notices

Bintana itself is MIT; see [`LICENSE`](LICENSE). The runtime embeds QuickJS,
and the Windows download also carries third-party binaries. This file is the
map to their notices.

## QuickJS

`vendor/quickjs` is quickjs-ng, MIT. The full notice is installed as
`LICENSE-QuickJS` beside `LICENSE`, and under `share/licenses/bintana`, so it
travels with every binary that embeds the engine.

## Linux and Flatpak

The Linux tarball and the Flatpak BaseApp link against the distribution's
libraries (and, in a Flatpak, the GNOME runtime's): GTK, GtkSourceView,
GStreamer, poppler and the rest. Those libraries are **not copied** into the
artifact; their licenses and source belong to the distribution or the runtime,
which is where a packager should look.

## The Windows portable zip and the Windows setup

`tools/windows-portable.sh` copies the MSYS2 UCRT64 DLLs the executables
import, plus the data GTK, GStreamer and poppler open at run time. The
installer built by `tools/pack.sh --nsis` installs that same tree. Those
binaries are third-party works under their own licenses, and they are
redistributed here.

- Every package's license text is copied to
  `share/licenses/bintana/msys2/<package>/`, **where MSYS2 ships one**. The file
  `share/licenses/bintana/MSYS2-PACKAGES.md` names the packages; a package
  without a license directory is listed with its source URL instead. The
  script copies what the environment provides and cannot invent a text the
  package does not carry.
- The source of each package is published at
  <https://packages.msys2.org/> and by the upstream project. A distributor who
  ships a binary from that tree is responsible for the source offer the
  package's license asks for.

What is in the bundle, and what its license asks to be carried:

| component | license | what travels |
|---|---|---|
| GTK 4, GtkSourceView 5, GLib, GIO, Pango, Cairo | LGPL-2.1-or-later | license text in `msys2/gtk4`, `msys2/gtksourceview5`, `msys2/glib2`, `msys2/pango`, `msys2/cairo`; source at packages.msys2.org |
| GStreamer and its plugins, including gst-plugins-rs | LGPL-2.0-or-later, with some plugins under other licenses | the Rust plugins' text is in `msys2/gst-plugins-rs`; MSYS2 does not package a license directory for the C core, whose LGPL text and source are at <https://gstreamer.freedesktop.org/> |
| poppler, poppler-glib | GPL-2.0-or-later | MSYS2 does not package a poppler license directory; the GPL text and source are at <https://poppler.freedesktop.org/> |
| libdvdread, libdvdnav, libdvdcss | GPL-2.0-or-later | license text in `msys2/libdvdread`, `msys2/libdvdnav`, `msys2/libdvdcss`; source at packages.msys2.org |
| libfdk-aac | Fraunhofer FDK AAC license | `msys2/libfdk-aac/`; the license requires the complete source of the library to accompany binary redistribution |
| OpenSSL | Apache-2.0 | license text in `msys2/openssl/` |
| Adwaita and AdwaitaLegacy icon themes | CC-BY-SA-3.0 | attribution: GNOME Project, <https://www.gnome.org> |
| libvterm | MIT | license text in `msys2/` |
| NSIS, when the compiler is bundled | zlib/libpng | its `COPYING` travels inside the NSIS directory |

**A distributor must review this list before publishing a build.** In
particular, the GPL and LGPL source offers and the FDK AAC source obligation
are not satisfied by copying the license text alone: ship the corresponding
sources (or a valid written offer), or leave those components out of the
bundle. Bintana's own MIT license does not relicense them.
