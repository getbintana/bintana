cmake_minimum_required(VERSION 3.16)
# The version lives here and nowhere else. It used to be a literal in rad.js
# while this line had none, so the two numbers could differ and nothing would
# say so; BTA_VERSION is set from this now (see bta_runtime.c).
project(bintana VERSION 0.3.1 LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Debug)
endif()

find_package(PkgConfig REQUIRED)

# **The floors are declared here and not just in the documentation.**  GTK 4.10
# is where `GtkAlertDialog` and `GtkFileDialog` arrive, and the runtime uses both
# unconditionally -- so an older GTK is a wall of implicit-declaration errors in
# the middle of a build, which reads like a broken source tree rather than an
# old distribution.  pkg-config answers the version question before a single
# file is compiled, and says which one it found.
pkg_check_modules(GTK4 REQUIRED IMPORTED_TARGET gtk4>=4.10)
pkg_check_modules(GTKSOURCE REQUIRED IMPORTED_TARGET gtksourceview-5>=5.0)
# Part of glib, and already installed wherever gtk4 is: `Exec`'s third stream
# wraps a descriptor the child inherits, which is `g_unix_input_stream_new`.
# **Unix only.**  Windows has no such stream and no gio-unix package at all;
# `Exec`'s `Control` option is refused there with a sentence (bta_sys.c), and
# the runtime needs none of it to build.
if(NOT WIN32)
    pkg_check_modules(GIOUNIX REQUIRED IMPORTED_TARGET gio-unix-2.0)
endif()

# Also part of glib: the plugin loader.  GModule is what makes `g_module_open`
# one mechanism for a `.so`, a `.dll` and a `.dylib` alike -- and because a
# plugin calls the runtime through a table and not through symbols, nothing has
# to be exported from this executable for it (runtime/include/bta_plugin.h).
pkg_check_modules(GMODULE REQUIRED IMPORTED_TARGET gmodule-2.0)

# The metadata host links GLib and GIO and nothing graphical.  GTK is a
# dependency of the widget files at compile time -- their headers name its types
# -- but the link is what this target proves can be without it.
pkg_check_modules(GLIBCORE REQUIRED IMPORTED_TARGET glib-2.0 gobject-2.0 gio-2.0)

# Optional: VTE is the pty behind `Terminal`, and it is the only dependency
# with no Windows port -- which is why it stopped being required. Without it
# the class is still there, a .form naming one still loads and every property
# still answers; what refuses is starting a child, and `Widget.Available`
# ("Terminal") is what says so before anything is drawn. The IDE's output pane
# is an ordinary read-only TextEditor now, so nothing on its critical path
# needs this.
pkg_check_modules(VTE IMPORTED_TARGET vte-2.91-gtk4)

# Optional: sqlite is what Database.Sqlite opens.  Optional and not required for
# the same reason the journal is: a program that draws windows and reads JSON
# needs none of it, and a runtime that refused to build without it would make
# every such program pay for a dependency it does not use.  Without it
# `Database.Sqlite` exists and says which package is missing, which is a better
# answer than a `Database` that is not there.
#
# The floor is the window function: `decimal_sum` is registered with
# `sqlite3_create_window_function`, which arrives in 3.25.  An older library
# would fail at link time, which reads like a broken source tree rather than
# an old distribution -- the same reason GTK declares its floor above.
pkg_check_modules(SQLITE3 IMPORTED_TARGET sqlite3>=3.25)

# Optional: ODBC is what Database.Odbc connects through -- unixODBC on Linux
# and macOS, found with pkg-config like sqlite, and `odbc32` on Windows, which
# is part of the system and whose headers MinGW-w64 carries, so it is always
# there.  Without it `Database.Odbc` exists and says which package is missing.
# iODBC is not looked for: its `SQLWCHAR` is a 4-byte `wchar_t`, and the text
# layer in bta_odbc.c is narrow UTF-8 on unixODBC and UTF-16 on Windows --
# docs/plans/odbc-plan.md has the measurement that decided it.
if(NOT WIN32)
    pkg_check_modules(ODBC IMPORTED_TARGET odbc)
endif()

# Optional: `PdfDocument` and `Probe.Pdf` -- reading a PDF: its pages, its
# text, its metadata, and a page drawn on a Painter, which is what a viewer is
# made of.  poppler-glib, the sqlite mould: without it both names exist and say
# which package is missing.  The floor is the date getters
# (`poppler_document_get_creation_date_time`); Ubuntu 24.04 has 24.02.
pkg_check_modules(POPPLER IMPORTED_TARGET poppler-glib>=22.02)

# Optional: `Printer.Names` and `Printer.Default` -- the list of printers and
# which one is the default.  It is GTK's **Unix** print backend and ships as a
# pkg-config module of its own; on Windows GTK opens the system's dialog and
# publishes no list at all.  Without it `Printer.Send` and `Printer.ToFile`
# work exactly the same -- the dialog is core GTK -- and the two questions
# refuse with a sentence rather than answering an empty list that cannot be
# told apart from a machine with no printer.
pkg_check_modules(UNIXPRINT IMPORTED_TARGET gtk4-unix-print)

# Optional: Log.Target = "Journal" writes straight to the systemd journal, with
# the level as its priority.  Without it the runtime still builds and logs to
# the terminal; asking for the journal then says so instead of pretending.
pkg_check_modules(SYSTEMD IMPORTED_TARGET libsystemd)

# Optional: libsoup is what Http speaks. Without it the runtime still builds
# and Http exists, saying which package is missing when called.
pkg_check_modules(SOUP IMPORTED_TARGET libsoup-3.0)

# Optional: GnuTLS is the AES-256-GCM behind `Cipher`, and `Key` -- a private
# key from a file or a PKCS#11 token, through p11-kit's modules.  It is already the TLS
# library under libsoup on a Linux desktop, but the headers are a separate
# `-devel` package and a program that never encrypts needs none of it -- so the
# mould is sqlite's: without it `Cipher` exists, `Available` is false and the
# verbs refuse naming the package.
pkg_check_modules(GNUTLS IMPORTED_TARGET gnutls)

# Optional: GStreamer is what Video and AudioPlayer play through (playbin3
# plus the gtk4paintablesink that puts the frames in a GtkPicture). Without
# it the runtime still builds and both exist, saying which package is missing
# when asked to play -- the same bargain sqlite and libsoup make. Only
# gstreamer-1.0 itself is needed to build: the sink is made by factory name
# and a plain path is turned into a URI with GLib, so neither the video nor
# the pbutils headers are required.
pkg_check_modules(GSTREAMER IMPORTED_TARGET gstreamer-1.0)

# Optional: libxml2 is what `Xml` parses and writes. Optional for the same
# reason sqlite is -- a program that draws windows and reads JSON needs none of
# it -- and the mould is sqlite's: without it `Xml` exists, `Available` is
# false and the verbs refuse with a sentence. Note that GTK4 itself already
# loads libxml2 at runtime on most desktops; what this asks for is the headers
# to build against.
pkg_check_modules(LIBXML IMPORTED_TARGET libxml-2.0)

# Optional: libsecret is what `Keyring` stores a token in on Linux. Optional
# like sqlite and libxml2 -- a program that keeps nothing secret needs none of
# it -- and without it Linux falls back to the File provider under the config
# directory. Windows uses the Credential Manager and macOS the Keychain, so
# libsecret has no Windows or macOS port to find. The runtime dependency it
# brings is libsecret's own shared object, which every GNOME desktop already
# has.
pkg_check_modules(SECRET IMPORTED_TARGET libsecret-1)

# Optional: sysprof-capture is what lets a Sysprof capture carry the runtime's
# own marks -- and what `--profile` writes to a file. Static and self-contained
# (no GLib of its own, BSD-2-Clause-Patent) and already pulled in on most
# desktops by another `-devel` package, so finding it is the ordinary case.
# Without it the runtime builds and profiles nothing: `--profile` refuses with
# a sentence naming the package, and the marks the runtime and GTK would raise
# are simply not raised. See runtime/src/bta_profile.c.
pkg_check_modules(SYSPROF IMPORTED_TARGET sysprof-capture-4)

# Optional: PoDoFo is `PdfDocument`'s writing half. Cairo writes the visual PDF;
# PoDoFo opens it and adds the AcroForm widgets a signer can fill, or encrypts
# it. Optional like sqlite: a program that only draws reports needs none of it,
# and without it `PdfDocument.CanWrite` is false and `AddFields`/`Encrypt`
# refuse naming the package.
# PoDoFo is C++17, which is why the language is enabled only when it is found.
option(BTA_WITH_PODOFO "Build PdfDocument's writing half with PoDoFo" ON)
if(BTA_WITH_PODOFO)
    pkg_check_modules(PODOFO IMPORTED_TARGET libpodofo)
else()
    set(PODOFO_FOUND FALSE)
endif()

# ---------------------------------------------------------------- QuickJS ---
# A fork of quickjs-ng, vendored under vendor/quickjs as a submodule:
# `getbintana/quickjs`, branch `bintana`, which is upstream v0.18.0 plus the
# twenty patches the runtime needs, a commit or more each.  See docs/agents/quickjs.md.
# A clone without `--recurse-submodules` leaves the directory empty, and the
# answer here names the one command that fixes it rather than letting the
# compiler fail on a missing `quickjs.c` three targets away.
if(NOT EXISTS "${CMAKE_SOURCE_DIR}/vendor/quickjs/quickjs.c")
    message(FATAL_ERROR
        "vendor/quickjs is empty -- run: git submodule update --init --recursive")
endif()

add_library(quickjs STATIC
    vendor/quickjs/quickjs.c
    vendor/quickjs/dtoa.c
    vendor/quickjs/libregexp.c
    vendor/quickjs/libunicode.c
)
target_include_directories(quickjs PUBLIC ${CMAKE_SOURCE_DIR}/vendor/quickjs)
target_compile_definitions(quickjs PRIVATE _GNU_SOURCE)
# `-funsigned-char` is how QuickJS is meant to be built: upstream's CMake has
# carried it since its first version, and Bellard's Makefile before that, so
# the engine's byte handling is written for an unsigned `char`.  x86 defaults
# to signed and ARM to unsigned, which without the flag made this one source
# two programs on the two architectures.
target_compile_options(quickjs PRIVATE -w -funsigned-char)
# `libm` and pthread are POSIX: MinGW has neither, and QuickJS needs neither
# there -- its Windows paths use the C runtime.  A `find_library` that fails
# sets the variable to `M_LIB-NOTFOUND`, which is a configure error if it is
# handed to `target_link_libraries`, so the whole line is guarded.
if(NOT WIN32)
    find_library(M_LIB m)
    target_link_libraries(quickjs PUBLIC ${M_LIB} pthread)
endif()

# ------------------------------------------------------------- JS prelude ---
# rad.js is baked into the binary so the runtime is a single self-contained
# executable; regenerating is part of the build.
# Two halves, because a Task's worker thread runs the language without the
# widgets: rad.js has to be evaluable with no `Widget` in the runtime, and
# forms.js is everything that is not. See docs/notes/task-threads.md.
set(PRELUDE_JS  ${CMAKE_SOURCE_DIR}/runtime/js/rad.js)
set(PRELUDE_H   ${CMAKE_BINARY_DIR}/generated/bta_prelude.h)
add_custom_command(
    OUTPUT ${PRELUDE_H}
    COMMAND ${CMAKE_COMMAND}
            -DINPUT=${PRELUDE_JS} -DOUTPUT=${PRELUDE_H} -DSYMBOL=bta_prelude_js
            -P ${CMAKE_SOURCE_DIR}/tools/embed_text.cmake
    DEPENDS ${PRELUDE_JS} ${CMAKE_SOURCE_DIR}/tools/embed_text.cmake
    COMMENT "Embedding rad.js prelude"
)
set(FORMS_JS    ${CMAKE_SOURCE_DIR}/runtime/js/forms.js)
set(FORMS_H     ${CMAKE_BINARY_DIR}/generated/bta_forms.h)
add_custom_command(
    OUTPUT ${FORMS_H}
    COMMAND ${CMAKE_COMMAND}
            -DINPUT=${FORMS_JS} -DOUTPUT=${FORMS_H} -DSYMBOL=bta_forms_js
            -P ${CMAKE_SOURCE_DIR}/tools/embed_text.cmake
    DEPENDS ${FORMS_JS} ${CMAKE_SOURCE_DIR}/tools/embed_text.cmake
    COMMENT "Embedding forms.js prelude"
)

# ------------------------------------------------------------- base sheet ---
# The runtime's own stylesheet, baked in for the same reason the prelude is:
# every application gets it, and nothing has to be installed beside the binary
# for a `ComboBox` to be able to wear `flat`.  See runtime/css/base.css.
set(BASE_CSS    ${CMAKE_SOURCE_DIR}/runtime/css/base.css)
set(BASE_CSS_H  ${CMAKE_BINARY_DIR}/generated/bta_base_css.h)
add_custom_command(
    OUTPUT ${BASE_CSS_H}
    COMMAND ${CMAKE_COMMAND}
            -DINPUT=${BASE_CSS} -DOUTPUT=${BASE_CSS_H} -DSYMBOL=bta_base_css
            -P ${CMAKE_SOURCE_DIR}/tools/embed_text.cmake
    DEPENDS ${BASE_CSS} ${CMAKE_SOURCE_DIR}/tools/embed_text.cmake
    COMMENT "Embedding base.css"
)

# ------------------------------------------------------ member signatures ---
# Every method and event declares its parameters in a one-line comment beside
# itself, and this is the table that publishes them: `Widget.Signature(type,
# name)` answers with no control built. Generated rather than written, so the
# declaration is in one place -- next to the thing it documents.
file(GLOB RUNTIME_C_SOURCES CONFIGURE_DEPENDS ${CMAKE_SOURCE_DIR}/runtime/src/*.c)
set(SIGNATURES_H ${CMAKE_BINARY_DIR}/generated/bta_signatures.h)
add_custom_command(
    OUTPUT ${SIGNATURES_H}
    COMMAND ${CMAKE_COMMAND}
            -DSRC_DIR=${CMAKE_SOURCE_DIR}/runtime/src
            -DOUTPUT=${SIGNATURES_H}
            -P ${CMAKE_SOURCE_DIR}/tools/extract_signatures.cmake
    DEPENDS ${RUNTIME_C_SOURCES} ${CMAKE_SOURCE_DIR}/tools/extract_signatures.cmake
    COMMENT "Extracting member signatures"
)

# ------------------------------------------------------------- bintana runtime ---
if(PODOFO_FOUND)
    enable_language(CXX)
    set(CMAKE_CXX_STANDARD 17)
    set(CMAKE_CXX_STANDARD_REQUIRED ON)
    set(BTA_PDF_SOURCES runtime/src/bta_pdf_podofo.cpp)
else()
    set(BTA_PDF_SOURCES)
endif()

# The tray is one API and one native backend per platform.  Windows and Linux
# are built; macOS is a stub until its stage -- it compiles and `Available`
# says false, so a project carrying a tray still builds and runs.
if(WIN32)
    set(BTA_TRAY_SOURCE runtime/src/bta_tray_win32.c)
    set(BTA_NOTIFICATION_SOURCE runtime/src/bta_notification_win32.c)
    set(BTA_SERIAL_SOURCE runtime/src/bta_serial_win32.c)
elseif(APPLE)
    set(BTA_TRAY_SOURCE runtime/src/bta_tray_cocoa.c)
    set(BTA_NOTIFICATION_SOURCE)
    set(BTA_SERIAL_SOURCE)
else()
    set(BTA_TRAY_SOURCE runtime/src/bta_tray_linux.c)
    set(BTA_NOTIFICATION_SOURCE)
    set(BTA_SERIAL_SOURCE)
endif()

# **Two hosts, two binaries.** On Linux the core is `bintana` and the
# graphical host is `bintana-gui`; Windows still ships the single graphical
# `bintana.exe` plus `bintanaw.exe` until its console host exists (Phase 3).
set(BTA_GUI_TARGET bintana)
if(NOT WIN32)
    set(BTA_GUI_TARGET bintana-gui)
endif()

add_executable(${BTA_GUI_TARGET}
    runtime/src/main.c
    runtime/src/bta_runtime.c
    runtime/src/bta_project.c
    runtime/src/bta_util.c
    runtime/src/bta_module.c
    runtime/src/bta_journal.c
    runtime/src/bta_widget.c
    runtime/src/bta_fixed.c
    runtime/src/bta_controls.c
    runtime/src/bta_layout.c
    runtime/src/bta_notebook.c
    runtime/src/bta_switcher.c
    runtime/src/bta_paint.c
    runtime/src/bta_text.c
    runtime/src/bta_editor.c
    runtime/src/bta_terminal.c
    runtime/src/bta_terminal_win32.c
    runtime/src/bta_menu.c
    runtime/src/bta_tree.c
    runtime/src/bta_table.c
    runtime/src/bta_treerows.c
    runtime/src/bta_debug.c
    runtime/src/bta_profile.c
    runtime/src/bta_sys.c
    runtime/src/bta_task.c
    runtime/src/bta_cancellable.c
    runtime/src/bta_lock.c
    runtime/src/bta_random.c
    runtime/src/bta_gzip.c
    runtime/src/bta_notification.c
    ${BTA_NOTIFICATION_SOURCE}
    runtime/src/bta_tray.c
    ${BTA_TRAY_SOURCE}
    runtime/src/bta_zip.c
    runtime/src/bta_probe.c
    runtime/src/bta_popover.c
    runtime/src/bta_desktop.c
    runtime/src/bta_printer.c
    runtime/src/bta_pdf.c
    runtime/src/bta_database.c
    runtime/src/bta_sqlite.c
    runtime/src/bta_odbc.c
    runtime/src/bta_xml.c
    runtime/src/bta_keyring.c
    runtime/src/bta_cipher.c
    runtime/src/bta_key.c
    runtime/src/bta_network.c
    runtime/src/bta_socket.c
    runtime/src/bta_serial.c
    ${BTA_SERIAL_SOURCE}
    runtime/src/bta_locale.c
    runtime/src/bta_bytes.c
    runtime/src/bta_bitmap.c
    runtime/src/bta_decimal.c
    runtime/src/bta_day.c
    runtime/src/bta_form.c
    runtime/src/bta_http.c
    runtime/src/bta_media.c
    runtime/src/bta_plugin.c
    ${BTA_PDF_SOURCES}
    ${PRELUDE_H}
    ${FORMS_H}
    ${BASE_CSS_H}
    ${SIGNATURES_H}
)
target_include_directories(${BTA_GUI_TARGET} PRIVATE
    ${CMAKE_SOURCE_DIR}/runtime/include
    ${CMAKE_BINARY_DIR}/generated
)
target_link_libraries(${BTA_GUI_TARGET} PRIVATE quickjs PkgConfig::GTK4 PkgConfig::GTKSOURCE
                                       PkgConfig::GMODULE)
if(WIN32)
    # `Shell_NotifyIconW` is shell32; the hidden window, the popup menu and the
    # icon handles are user32; the DIB behind a theme icon is gdi32.  The WinRT
    # toast needs `RoInitialize`/`RoGetActivationFactory` from runtimeobject and
    # COM from ole32.  GTK links them already, and naming them here is what
    # makes these halves independent of GTK's link line.
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE shell32 user32 gdi32 runtimeobject ole32 advapi32 winspool)
endif()

if(APPLE)
    # Keychain, for `Keyring`'s macOS provider.
    find_library(SECURITY_FRAMEWORK Security)
    if(NOT SECURITY_FRAMEWORK)
        message(FATAL_ERROR "no Security framework: Keyring's macOS provider "
                            "needs it")
    endif()
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE ${SECURITY_FRAMEWORK})
endif()
if(GIOUNIX_FOUND)
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE PkgConfig::GIOUNIX)
endif()

if(VTE_FOUND)
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE PkgConfig::VTE)
    target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_HAVE_VTE=1)
    message(STATUS "vte ${VTE_VERSION}: Terminal can run a child")
else()
    message(STATUS "no vte: Terminal exists and refuses to run one")
endif()

# Windows has no VTE.  ConPTY (Windows 10 1809+) gives the child a real
# console and libvterm interprets the VT sequences that come out of it;
# `bta_terminal_win32.c` is the widget that draws the grid.  Optional like VTE:
# without libvterm the class exists and the three verbs that need a child
# refuse, so a project that only draws a form naming a Terminal still loads.
if(WIN32)
    # No imported target: MSYS2's vterm.pc writes `includedir=/ucrt64/include`
    # literally instead of through `prefix`, and CMake refuses to generate a
    # project whose imported target points outside the filesystem.  The
    # compiler's own search path already has that directory, and the library
    # is a plain `-lvterm`.
    pkg_check_modules(LIBVTERM vterm)
    if(LIBVTERM_FOUND)
        target_link_libraries(${BTA_GUI_TARGET} PRIVATE ${LIBVTERM_LINK_LIBRARIES})
        target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_HAVE_LIBVTERM=1)
        message(STATUS "libvterm ${LIBVTERM_VERSION}: Terminal runs a child through ConPTY")
    else()
        message(STATUS "no libvterm: Terminal exists and refuses to run one")
    endif()
endif()

if(POPPLER_FOUND)
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE PkgConfig::POPPLER)
    target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_HAVE_POPPLER=1)
    message(STATUS "poppler-glib ${POPPLER_VERSION}: PdfDocument and Probe.Pdf read a PDF")
else()
    message(STATUS "no poppler-glib: PdfDocument's reading half and Probe.Pdf will say so when called")
endif()

if(SQLITE3_FOUND)
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE PkgConfig::SQLITE3)
    target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_HAVE_SQLITE=1)
    message(STATUS "sqlite3 ${SQLITE3_VERSION}: Database.Sqlite is available")
else()
    message(STATUS "no sqlite3: Database.Sqlite will say so when called")
endif()

if(WIN32)
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE odbc32)
    target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_HAVE_ODBC=1)
    message(STATUS "odbc32: Database.Odbc is available")
elseif(ODBC_FOUND)
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE PkgConfig::ODBC)
    target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_HAVE_ODBC=1)
    message(STATUS "unixODBC ${ODBC_VERSION}: Database.Odbc is available")
else()
    message(STATUS "no unixODBC: Database.Odbc will say so when called")
endif()

if(UNIXPRINT_FOUND)
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE PkgConfig::UNIXPRINT)
    target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_HAVE_UNIX_PRINT=1)
    message(STATUS "gtk4-unix-print ${UNIXPRINT_VERSION}: Printer.Names and Printer.Default can answer")
else()
    message(STATUS "no gtk4-unix-print: Printer.Names and Printer.Default will say so; printing itself is unaffected")
endif()

if(SYSTEMD_FOUND)
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE PkgConfig::SYSTEMD)
    target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_HAVE_JOURNAL=1)
endif()

if(SOUP_FOUND)
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE PkgConfig::SOUP)
    target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_HAVE_SOUP=1)
    message(STATUS "libsoup ${SOUP_VERSION}: Http is available")
else()
    message(STATUS "no libsoup: Http will say so when called")
endif()

if(GNUTLS_FOUND)
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE PkgConfig::GNUTLS)
    target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_HAVE_GNUTLS=1)
    message(STATUS "gnutls ${GNUTLS_VERSION}: Cipher and Key are available")
else()
    message(STATUS "no gnutls: Cipher and Key exist and refuse")
endif()

if(GSTREAMER_FOUND)
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE PkgConfig::GSTREAMER)
    target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_HAVE_GST=1)
    message(STATUS "gstreamer ${GSTREAMER_VERSION}: Video and AudioPlayer are available")
else()
    message(STATUS "no gstreamer: Video and AudioPlayer will say so when called")
endif()

if(LIBXML_FOUND)
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE PkgConfig::LIBXML)
    target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_HAVE_LIBXML=1)
    message(STATUS "libxml2 ${LIBXML_VERSION}: Xml is available")
else()
    message(STATUS "no libxml2: Xml exists and refuses to read anything")
endif()

if(SECRET_FOUND)
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE PkgConfig::SECRET)
    target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_HAVE_LIBSECRET=1)
    message(STATUS "libsecret ${SECRET_VERSION}: Keyring uses the Secret Service")
elseif(WIN32)
    message(STATUS "no libsecret: Keyring uses the Credential Manager")
elseif(APPLE)
    message(STATUS "no libsecret: Keyring uses the Keychain")
else()
    message(STATUS "no libsecret: Keyring falls back to the File provider")
endif()

if(SYSPROF_FOUND)
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE PkgConfig::SYSPROF)
    target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_HAVE_SYSPROF=1)
    message(STATUS "sysprof-capture ${SYSPROF_VERSION}: --profile can write a "
                   "capture, and a Sysprof run carries the runtime's marks")
else()
    message(STATUS "no sysprof-capture: --profile says so when asked; a Sysprof "
                   "run still shows the samples")
endif()

if(PODOFO_FOUND)
    target_link_libraries(${BTA_GUI_TARGET} PRIVATE PkgConfig::PODOFO)
    target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_HAVE_PODOFO=1)
    message(STATUS "podofo ${PODOFO_VERSION}: PdfDocument can add form fields and encrypt")
else()
    message(STATUS "no podofo: PdfDocument refuses to write, naming the package")
endif()
target_compile_definitions(${BTA_GUI_TARGET} PRIVATE BTA_VERSION_STRING="${PROJECT_VERSION}")
# -Wshadow, -Wnull-dereference and -Wformat=2 are clean across runtime/src
# today; keeping them on is what keeps them clean.  (-Wconversion is not here
# on purpose: GTK's own guint/int mixing would bury the two real sign flips,
# which carry explicit casts instead.)
target_compile_options(${BTA_GUI_TARGET} PRIVATE -Wall -Wextra -Wno-unused-parameter
                                          -Wshadow -Wnull-dereference -Wformat=2)

# ----------------------------------------------------------- metadata host ---
# Phase 1 of docs/plans/headless-runtime-plan.md: the class rows and their
# property tables, with no toolkit in the link.  `BTA_META_ONLY` turns every
# property entry into a stub and drops `build`/`probe` from each row; the
# functions those rows named are then unreferenced, and the linker's GC drops
# everything that would call GTK.  `bta_meta.c` is the small host around it.
#
# **Not installed.**  It is a test target: `tests/headless.sh` runs a script
# against it and checks what `Widget.*` answers, and `ldd` must not list GTK,
# GtkSourceView or VTE.
set(BTA_META_SOURCES
    runtime/src/bta_meta.c
    runtime/src/bta_util.c
    runtime/src/bta_widget.c
    runtime/src/bta_controls.c
    runtime/src/bta_layout.c
    runtime/src/bta_notebook.c
    runtime/src/bta_switcher.c
    runtime/src/bta_paint.c
    runtime/src/bta_text.c
    runtime/src/bta_editor.c
    runtime/src/bta_terminal.c
    runtime/src/bta_menu.c
    runtime/src/bta_tree.c
    runtime/src/bta_table.c
    runtime/src/bta_media.c
    ${PRELUDE_H}
    ${FORMS_H}
    ${SIGNATURES_H}
)
# The Windows host is Phase 3's: its linker and its `bintanaw.exe` split need a
# real desktop to prove, and the metadata host does not belong in a job that
# cannot run `tests/headless.sh` yet.
if(NOT WIN32)
    add_executable(bintana-meta ${BTA_META_SOURCES})
    target_include_directories(bintana-meta PRIVATE
        ${CMAKE_SOURCE_DIR}/runtime/include
        ${CMAKE_BINARY_DIR}/generated
        ${GTK4_INCLUDE_DIRS}
        ${GTKSOURCE_INCLUDE_DIRS}
        ${VTE_INCLUDE_DIRS}
        ${GSTREAMER_INCLUDE_DIRS}
    )
    target_compile_definitions(bintana-meta PRIVATE
        BTA_META_ONLY
        BTA_VERSION_STRING="${PROJECT_VERSION}"
    )
    if(VTE_FOUND)
        target_compile_definitions(bintana-meta PRIVATE BTA_HAVE_VTE=1)
    endif()
    if(GSTREAMER_FOUND)
        target_compile_definitions(bintana-meta PRIVATE BTA_HAVE_GST=1)
    endif()
    target_link_libraries(bintana-meta PRIVATE quickjs PkgConfig::GLIBCORE)
    target_compile_options(bintana-meta PRIVATE
        # `-O2` merges the GObject class structs G_DEFINE_TYPE builds into one
        # `.data.rel.ro` section, and the linker then keeps the vfuncs that
        # point at GTK even though `get_type` itself is dropped. `-O1` keeps
        # them sectioned; the metadata host has no hot path to lose.
        -O1
        -ffunction-sections -fdata-sections
        -Wall -Wextra -Wno-unused-parameter -Wno-unused-function -Wshadow
    )
    if(APPLE)
        target_link_options(bintana-meta PRIVATE -Wl,-dead_strip)
    else()
        target_link_options(bintana-meta PRIVATE -Wl,--gc-sections)
    endif()
endif()

# ----------------------------------------------------------- console host ---
# The console core: `bintana --version`, `check`, a project's `main` and the
# core globals and the metadata rows, and no toolkit in the link.  The widget
# files are the same `BTA_META_ONLY` ones; `bta_sys.c` leaves out the desktop
# objects under `BTA_HEADLESS`; `bta_headless.c` supplies the few symbols that
# live in `bta_runtime.c` today.  Not installed yet: the package split is
# Stage 1 of docs/plans/distribution-plan.md.
if(NOT WIN32)
    set(BTA_HEADLESS_SOURCES
        runtime/src/bta_headless.c
        runtime/src/bta_project.c
        runtime/src/bta_util.c
        runtime/src/bta_module.c
        runtime/src/bta_debug.c
        runtime/src/bta_sys.c
        runtime/src/bta_form.c
        runtime/src/bta_locale.c
        runtime/src/bta_xml.c
        runtime/src/bta_network.c
        runtime/src/bta_decimal.c
        runtime/src/bta_day.c
        runtime/src/bta_bytes.c
        runtime/src/bta_cancellable.c
        ${PRELUDE_H}
    )

    # The widget metadata is a document the console host loads for `check`.
    # `bintana-meta` is the generator (and the test): it is not installed, and
    # the core never links the widget files.
    set(WIDGETS_JSON ${CMAKE_BINARY_DIR}/check/widgets.json)
    file(MAKE_DIRECTORY ${CMAKE_BINARY_DIR}/check)
    add_custom_command(
        OUTPUT ${WIDGETS_JSON}
        COMMAND $<TARGET_FILE:bintana-meta> --dump ${WIDGETS_JSON}
        DEPENDS bintana-meta
        COMMENT "Dumping widget metadata"
    )
    add_custom_target(bintana-check-data ALL DEPENDS ${WIDGETS_JSON})
    configure_file(${CMAKE_SOURCE_DIR}/runtime/js/widget-meta.js
                   ${CMAKE_BINARY_DIR}/check/WidgetMeta.js COPYONLY)

    add_executable(bintana ${BTA_HEADLESS_SOURCES})
    target_include_directories(bintana PRIVATE
        ${CMAKE_SOURCE_DIR}/runtime/include
        ${CMAKE_BINARY_DIR}/generated
        ${GTK4_INCLUDE_DIRS}
        ${GTKSOURCE_INCLUDE_DIRS}
        ${VTE_INCLUDE_DIRS}
        ${GSTREAMER_INCLUDE_DIRS}
        ${LIBXML_INCLUDE_DIRS}
    )
    target_compile_definitions(bintana PRIVATE
        BTA_HEADLESS
        BTA_VERSION_STRING="${PROJECT_VERSION}"
    )
    if(VTE_FOUND)
        target_compile_definitions(bintana PRIVATE BTA_HAVE_VTE=1)
    endif()
    if(GSTREAMER_FOUND)
        target_compile_definitions(bintana PRIVATE BTA_HAVE_GST=1)
    endif()
    if(LIBXML_FOUND)
        target_compile_definitions(bintana PRIVATE BTA_HAVE_LIBXML=1)
        target_link_libraries(bintana PRIVATE PkgConfig::LIBXML)
    endif()
    add_dependencies(bintana bintana-check-data)
    target_link_libraries(bintana PRIVATE
        quickjs PkgConfig::GLIBCORE)
    if(NOT WIN32)
        target_link_libraries(bintana PRIVATE PkgConfig::GIOUNIX)
    endif()
    target_compile_options(bintana PRIVATE
        -ffunction-sections -fdata-sections
        -Wall -Wextra -Wno-unused-parameter -Wno-unused-function -Wshadow
    )
    target_link_options(bintana PRIVATE -Wl,--gc-sections)
endif()

# ----------------------------------------------------------- test plugins ---
# The shared objects the suite loads, built here so `cmake --build build` is the
# whole of what testing them takes.  They are **not installed**: what this tree
# ships is the mechanism, and a plugin belongs to its library.
#
# **They link nothing.**  Not quickjs, not the runtime, not gtk4: a plugin calls
# the host through the table in runtime/include/bta_plugin.h, so a capability
# reached through a symbol is a link error here rather than something that
# happens to work.
#
# The output lands in `<build>/testlibs/<name>/<name>.so`, which is the layout a
# library directory has.  tests/widgets copies one from beside the running
# binary into a scratch library and lets `uses` find it -- which is also how it
# works against `BINTANA=<other-build>/bintana`.
function(bta_test_plugin target source)
    add_library(${target} MODULE ${source})
    target_include_directories(${target} PRIVATE ${CMAKE_SOURCE_DIR}/runtime/include)
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wno-unused-parameter
                                              -Wshadow -Wnull-dereference -Wformat=2)
    set_target_properties(${target} PROPERTIES
        PREFIX ""
        OUTPUT_NAME ${target}
        LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/testlibs/${target})
endfunction()

bta_test_plugin(testplug tests/plugins/testplug.c)
# A shared object with no entry point at all: the loader has to say which file
# and why, and the suite asserts that it does.
bta_test_plugin(testplug-bare tests/plugins/bare.c)
# The same source claiming an ABI this runtime does not speak.
bta_test_plugin(testplug-old tests/plugins/testplug.c)
target_compile_definitions(testplug-old PRIVATE TESTPLUG_ABI=0)

# **The golden one**: `tests/plugins/testplug.c` compiled against the frozen
# copy of the version-1 header instead of the live one, so the suite loads a
# plugin built to the *offsets* of ABI 1.  A field reordered in `BtaHost`
# without the number moving is invisible to a plugin recompiled from the
# current source and fatal to this one -- which is the one thing the ABI
# number promises and nothing else here can check.  The note at the top of
# tests/plugins/abi1/bta_plugin.h says when it goes away.
add_library(testplug-abi1 MODULE tests/plugins/testplug.c)
target_include_directories(testplug-abi1 PRIVATE
                           ${CMAKE_SOURCE_DIR}/tests/plugins/abi1)
target_compile_options(testplug-abi1 PRIVATE -Wall -Wextra -Wno-unused-parameter
                                                 -Wshadow -Wnull-dereference -Wformat=2)
set_target_properties(testplug-abi1 PROPERTIES
    PREFIX ""
    OUTPUT_NAME testplug-abi1
    LIBRARY_OUTPUT_DIRECTORY ${CMAKE_BINARY_DIR}/testlibs/testplug-abi1)

# ----------------------------------------------------------------- install ---
# `cmake --install build` (or `make install`) puts the whole project where a
# desktop can find it: the runtime, the IDE, the examples, and the two files
# that make the IDE an application rather than a directory somebody knows the
# path of.
#
#   <bindir>/bintana                                 the runtime
#   <bindir>/bintana-ide                            the IDE, as one word
#   <datadir>/bintana/ide/                      the IDE, as the project it is
#   <datadir>/bintana/examples/                 the same examples, to open
#   <datadir>/applications/bintana-ide.desktop      the menu entry
#   <datadir>/icons/hicolor/scalable/apps/       its icon
#   <docdir>/                                    README.md, LICENSE, docs/
#
# **The IDE is installed as a project directory and not as a payload**, which is
# the rule of this repository showing up in the packaging: `bintana <dir>` is how
# every Bintana application is started, and the IDE is one. Nothing here
# rewrites, bundles or compiles it -- the tree under `ide/` is copied, and the
# runtime finds its forms, its icons and its `po/` beside it exactly as it does
# in the source tree. An installed IDE that needed a step the source tree does
# not would be a second IDE to keep working.
include(GNUInstallDirs)

set(BTA_DATADIR ${CMAKE_INSTALL_DATADIR}/bintana)

# What the launcher has to walk from bindir to reach the IDE. See tools/bintana-ide.in:
# it resolves its own location at run time, so this hop is what survives an
# install staged somewhere else -- `--prefix`, DESTDIR -- and an absolute path
# would not.
file(RELATIVE_PATH BTA_BIN_TO_IDE
     ${CMAKE_INSTALL_FULL_BINDIR} ${CMAKE_INSTALL_FULL_DATADIR}/bintana/ide)
# Which binary the launcher execs: the graphical host on Unix, the single
# graphical `bintana` on Windows.
set(BTA_IDE_EXE bintana-gui)
if(WIN32)
    set(BTA_IDE_EXE bintana)
endif()
configure_file(tools/bintana-ide.in ${CMAKE_BINARY_DIR}/bintana-ide @ONLY)

install(TARGETS ${BTA_GUI_TARGET} RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
if(NOT WIN32)
    install(TARGETS bintana RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
endif()
install(PROGRAMS ${CMAKE_BINARY_DIR}/bintana-ide DESTINATION ${CMAKE_INSTALL_BINDIR})

# **`bintanaw.exe` on Windows: the same runtime, without a console.** Windows
# decides by a field of the executable's header whether starting it opens a
# console, and `bintana.exe` is a console program -- which it has to be, for
# `--version`, `print`, a `main` project and the suite. Started from a shortcut,
# though, it brings a black window up behind the application's own. The
# `pythonw.exe` / `javaw.exe` answer: a second executable whose header says
# "GUI", for the shortcuts an installer writes (`lib/package/Nsis.js`).
#
# It is **the same file with that one field changed** (`objcopy --subsystem
# windows`, what Microsoft's `editbin /SUBSYSTEM:WINDOWS` does), not a second
# link: MinGW starts `main` the same way under either subsystem, so there is
# nothing to compile differently -- and two targets would be every option above
# spelled twice. What it gives up is the console: its `print` goes nowhere.
if(WIN32)
    if(NOT CMAKE_OBJCOPY)
        message(FATAL_ERROR "no objcopy: bintanaw.exe is bintana.exe with its "
                            "PE subsystem set to windows, and objcopy is what sets it")
    endif()
    set(BTA_GUI_EXE ${CMAKE_BINARY_DIR}/bintanaw.exe)
    add_custom_command(TARGET ${BTA_GUI_TARGET} POST_BUILD
        COMMAND ${CMAKE_OBJCOPY} --subsystem windows $<TARGET_FILE:${BTA_GUI_TARGET}> ${BTA_GUI_EXE}
        BYPRODUCTS ${BTA_GUI_EXE}
        COMMENT "bintanaw.exe: the runtime without a console")
    install(PROGRAMS ${BTA_GUI_EXE} DESTINATION ${CMAKE_INSTALL_BINDIR})
endif()

# `ide/` and `examples/` whole, because a Bintana project *is* its directory:
# listing the files here would mean a new form in the IDE silently missing from
# every install until somebody remembered this line. The .pot is the only thing
# left out -- it is what a translator merges from, not something the runtime
# reads.
install(DIRECTORY ide/ DESTINATION ${BTA_DATADIR}/ide
        PATTERN "*.pot" EXCLUDE)
install(DIRECTORY examples/ DESTINATION ${BTA_DATADIR}/examples
        PATTERN "*.pot" EXCLUDE)

# `lib/` the same way, and for the same reason: a library is its directory. The
# runtime finds it one hop from its own binary -- <bin>/../share/bintana/lib
# installed, <bin>/../lib in the source tree -- so this line and nothing else is
# what an installed library needs. See `lib_candidates` in bta_runtime.c.
install(DIRECTORY lib/ DESTINATION ${BTA_DATADIR}/lib
        PATTERN "*.pot" EXCLUDE)

# `bintana check` is a console project and finds its sources the same way the
# IDE does: one hop from the binary, under the data directory.
install(DIRECTORY tools/check DESTINATION ${BTA_DATADIR}/tools
        PATTERN "*.pot" EXCLUDE)

# The console host's check data: the generated metadata and the script that
# answers `Widget.*` over it. No binary; `bintana` loads both only for `check`.
if(NOT WIN32)
    install(FILES runtime/js/widget-meta.js
            DESTINATION ${BTA_DATADIR}/check RENAME WidgetMeta.js)
    install(FILES ${WIDGETS_JSON} DESTINATION ${BTA_DATADIR}/check)
endif()

# **One header, and that is the whole development surface a plugin needs.** Not
# `bta.h` and not `quickjs.h`: a plugin links neither the runtime nor the
# engine, so what it compiles against is the callback table and nothing else
# (docs/plugins.md). The pkg-config file is the one line that points a compiler
# at it; it carries no `Libs`, because there is nothing to link.
#
# **Two of them, because there are two situations.** The installed one is
# relocatable -- its prefix comes from the file's own location, which is what
# survives `--prefix` and a packager's `DESTDIR`. The other describes this
# *source tree* and is what lets a plugin be built against a checkout without
# installing anything: `PKG_CONFIG_PATH=<build>/pkgconfig`. They are written to
# different directories so a path can never pick the wrong one.
file(MAKE_DIRECTORY ${CMAKE_BINARY_DIR}/pkgconfig/installed)
configure_file(tools/bintana.pc.in
               ${CMAKE_BINARY_DIR}/pkgconfig/installed/bintana.pc @ONLY)
configure_file(tools/bintana-uninstalled.pc.in
               ${CMAKE_BINARY_DIR}/pkgconfig/bintana.pc @ONLY)
install(FILES runtime/include/bta_plugin.h
        DESTINATION ${CMAKE_INSTALL_INCLUDEDIR}/bintana)
install(FILES ${CMAKE_BINARY_DIR}/pkgconfig/installed/bintana.pc
        DESTINATION ${CMAKE_INSTALL_LIBDIR}/pkgconfig)

install(FILES tools/bintana-ide.desktop
        DESTINATION ${CMAKE_INSTALL_DATADIR}/applications)
install(FILES tools/bintana-ide.svg
        DESTINATION ${CMAKE_INSTALL_DATADIR}/icons/hicolor/scalable/apps)
# The project file's type, so a desktop hands `project.btp` to the IDE; the
# IDE's own drawing is reused under the MIME name, because a file manager looks
# for it in the mimetypes context and not in apps.
install(FILES tools/bintana.xml
        DESTINATION ${CMAKE_INSTALL_DATADIR}/mime/packages)
install(FILES tools/bintana-ide.svg
        DESTINATION ${CMAKE_INSTALL_DATADIR}/icons/hicolor/scalable/mimetypes
        RENAME application-x-bintana-project.svg)

install(FILES README.md LICENSE DESTINATION ${CMAKE_INSTALL_DOCDIR})
install(DIRECTORY docs/ DESTINATION ${CMAKE_INSTALL_DOCDIR}/docs)

# `cmake --build build --target uninstall` (or `make -C build uninstall`).
# CMake has no uninstall of its own, and removing the manifest is the only
# version of it that cannot take something else with it; tools/uninstall.cmake.in
# is the script and carries the argument.
configure_file(tools/uninstall.cmake.in ${CMAKE_BINARY_DIR}/uninstall.cmake @ONLY)
add_custom_target(uninstall
    COMMAND ${CMAKE_COMMAND} -P ${CMAKE_BINARY_DIR}/uninstall.cmake
    COMMENT "Removing what `cmake --install` recorded")
