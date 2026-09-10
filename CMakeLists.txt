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
pkg_check_modules(GTK4 REQUIRED IMPORTED_TARGET gtk4)
pkg_check_modules(GTKSOURCE REQUIRED IMPORTED_TARGET gtksourceview-5)

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
pkg_check_modules(SQLITE3 IMPORTED_TARGET sqlite3)

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
find_library(M_LIB m)
target_link_libraries(quickjs PUBLIC ${M_LIB} pthread)

# ------------------------------------------------------------- JS prelude ---
# rad.js is baked into the binary so the runtime is a single self-contained
# executable; regenerating is part of the build.
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
    runtime/src/bta_sys.c
    runtime/src/bta_database.c
    runtime/src/bta_sqlite.c
    runtime/src/bta_locale.c
    runtime/src/bta_bytes.c
    runtime/src/bta_decimal.c
    runtime/src/bta_day.c
    runtime/src/bta_form.c
    runtime/src/bta_http.c
    runtime/src/bta_media.c
    ${PRELUDE_H}
)
target_include_directories(bintana PRIVATE
    ${CMAKE_SOURCE_DIR}/runtime/include
    ${CMAKE_BINARY_DIR}/generated
)
target_link_libraries(bintana PRIVATE quickjs PkgConfig::GTK4 PkgConfig::GTKSOURCE)

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
target_compile_options(bintana PRIVATE -Wall -Wextra -Wno-unused-parameter)

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

install(FILES tools/bintana-ide.desktop
        DESTINATION ${CMAKE_INSTALL_DATADIR}/applications)
install(FILES tools/bintana-ide.svg
        DESTINATION ${CMAKE_INSTALL_DATADIR}/icons/hicolor/scalable/apps)

install(FILES README.md LICENSE DESTINATION ${CMAKE_INSTALL_DOCDIR})
install(DIRECTORY docs/ DESTINATION ${CMAKE_INSTALL_DOCDIR}/docs)
