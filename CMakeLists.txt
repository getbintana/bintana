cmake_minimum_required(VERSION 3.16)
# The version lives here and nowhere else. It used to be a literal in rad.js
# while this line had none, so the two numbers could differ and nothing would
# say so; BTA_VERSION is set from this now (see bta_runtime.c).
project(bintana VERSION 0.1.0 LANGUAGES C)

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

# Optional: GStreamer is what Video and AudioPlayer play through (playbin3
# plus the gtk4paintablesink that puts the frames in a GtkPicture). Without
# it the runtime still builds and both exist, saying which package is missing
# when asked to play -- the same bargain sqlite and libsoup make. Only
# gstreamer-1.0 itself is needed to build: the sink is made by factory name
# and a plain path is turned into a URI with GLib, so neither the video nor
# the pbutils headers are required.
pkg_check_modules(GSTREAMER IMPORTED_TARGET gstreamer-1.0)

# ---------------------------------------------------------------- QuickJS ---
# quickjs-ng, vendored under vendor/quickjs (see vendor/quickjs/VERSION).
add_library(quickjs STATIC
    vendor/quickjs/quickjs.c
    vendor/quickjs/dtoa.c
    vendor/quickjs/libregexp.c
    vendor/quickjs/libunicode.c
)
target_include_directories(quickjs PUBLIC ${CMAKE_SOURCE_DIR}/vendor/quickjs)
target_compile_definitions(quickjs PRIVATE _GNU_SOURCE)
target_compile_options(quickjs PRIVATE -w)
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
# forms.js is everything that is not. See docs/plans/task-plan.md.
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
add_executable(bintana
    runtime/src/main.c
    runtime/src/bta_runtime.c
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
    runtime/src/bta_menu.c
    runtime/src/bta_tree.c
    runtime/src/bta_table.c
    runtime/src/bta_treerows.c
    runtime/src/bta_debug.c
    runtime/src/bta_sys.c
    runtime/src/bta_task.c
    runtime/src/bta_lock.c
    runtime/src/bta_desktop.c
    runtime/src/bta_printer.c
    runtime/src/bta_database.c
    runtime/src/bta_sqlite.c
    runtime/src/bta_locale.c
    runtime/src/bta_bytes.c
    runtime/src/bta_decimal.c
    runtime/src/bta_day.c
    runtime/src/bta_form.c
    runtime/src/bta_http.c
    runtime/src/bta_media.c
    runtime/src/bta_plugin.c
    ${PRELUDE_H}
    ${FORMS_H}
    ${SIGNATURES_H}
)
target_include_directories(bintana PRIVATE
    ${CMAKE_SOURCE_DIR}/runtime/include
    ${CMAKE_BINARY_DIR}/generated
)
target_link_libraries(bintana PRIVATE quickjs PkgConfig::GTK4 PkgConfig::GTKSOURCE
                                       PkgConfig::GMODULE)
if(GIOUNIX_FOUND)
    target_link_libraries(bintana PRIVATE PkgConfig::GIOUNIX)
endif()

if(VTE_FOUND)
    target_link_libraries(bintana PRIVATE PkgConfig::VTE)
    target_compile_definitions(bintana PRIVATE BTA_HAVE_VTE=1)
    message(STATUS "vte ${VTE_VERSION}: Terminal can run a child")
else()
    message(STATUS "no vte: Terminal exists and refuses to run one")
endif()

if(SQLITE3_FOUND)
    target_link_libraries(bintana PRIVATE PkgConfig::SQLITE3)
    target_compile_definitions(bintana PRIVATE BTA_HAVE_SQLITE=1)
    message(STATUS "sqlite3 ${SQLITE3_VERSION}: Database.Sqlite is available")
else()
    message(STATUS "no sqlite3: Database.Sqlite will say so when called")
endif()

if(UNIXPRINT_FOUND)
    target_link_libraries(bintana PRIVATE PkgConfig::UNIXPRINT)
    target_compile_definitions(bintana PRIVATE BTA_HAVE_UNIX_PRINT=1)
    message(STATUS "gtk4-unix-print ${UNIXPRINT_VERSION}: Printer.Names and Printer.Default can answer")
else()
    message(STATUS "no gtk4-unix-print: Printer.Names and Printer.Default will say so; printing itself is unaffected")
endif()

if(SYSTEMD_FOUND)
    target_link_libraries(bintana PRIVATE PkgConfig::SYSTEMD)
    target_compile_definitions(bintana PRIVATE BTA_HAVE_JOURNAL=1)
endif()

if(SOUP_FOUND)
    target_link_libraries(bintana PRIVATE PkgConfig::SOUP)
    target_compile_definitions(bintana PRIVATE BTA_HAVE_SOUP=1)
    message(STATUS "libsoup ${SOUP_VERSION}: Http is available")
else()
    message(STATUS "no libsoup: Http will say so when called")
endif()

if(GSTREAMER_FOUND)
    target_link_libraries(bintana PRIVATE PkgConfig::GSTREAMER)
    target_compile_definitions(bintana PRIVATE BTA_HAVE_GST=1)
    message(STATUS "gstreamer ${GSTREAMER_VERSION}: Video and AudioPlayer are available")
else()
    message(STATUS "no gstreamer: Video and AudioPlayer will say so when called")
endif()
target_compile_definitions(bintana PRIVATE BTA_VERSION_STRING="${PROJECT_VERSION}")
# -Wshadow, -Wnull-dereference and -Wformat=2 are clean across runtime/src
# today; keeping them on is what keeps them clean.  (-Wconversion is not here
# on purpose: GTK's own guint/int mixing would bury the two real sign flips,
# which carry explicit casts instead.)
target_compile_options(bintana PRIVATE -Wall -Wextra -Wno-unused-parameter
                                          -Wshadow -Wnull-dereference -Wformat=2)

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
configure_file(tools/bintana-ide.in ${CMAKE_BINARY_DIR}/bintana-ide @ONLY)

install(TARGETS bintana RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
install(PROGRAMS ${CMAKE_BINARY_DIR}/bintana-ide DESTINATION ${CMAKE_INSTALL_BINDIR})

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

# The declarations an editor that is not the Bintana IDE reads, which is the
# whole of what makes VS Code work on a Bintana project. Installed beside the
# libraries rather than with the docs, because it is read by a tool and not by a
# person: a `tsconfig.json` names it, the way `uses` names a library.
# `tools/typings` writes it (tests/typings.sh) and `tests/api.sh` fails when it
# and the runtime disagree.
install(FILES tools/typings/bintana.d.ts DESTINATION ${BTA_DATADIR})

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
