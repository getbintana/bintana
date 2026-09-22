# Extracts the member signatures declared as one-line comments beside their C
# entry, and writes the table `Widget.Signature` answers with.
#
#   cmake -DSRC_DIR=runtime/src -DOUTPUT=bta_signatures.h -P extract_signatures.cmake
#
# The comment is the documentation's own spelling, on the line directly above
# what it documents:
#
#     /* Bounds([container]) */
#     JS_CFUNC_DEF("Bounds", 1, w_bounds),
#
#     /* MouseDown(x, y, button, ctrl, shift) */
#     BTA_CLASS_TEXT("Button", ...)
#
# A method's goes above its entry; an event's above the class row that already
# declares the event -- one line per event, because `BtaClass.events` is a
# comma separated list and a parameter list has commas of its own. The class a
# table belongs to is read off the registration line, the same rule `tests/api`
# reads it with; `base` is the one alias, for Widget's own table.
#
# The output is a C table and not a JS one so the runtime can publish it with
# no control built and no display: `Widget.Signature(type, name)`.

set(_owners "")     # table name -> class name
set(_entries "")    # "owner|member|signature|event" in source order

# The sources are globbed here rather than listed on the command line: a list
# has a separator the shell would eat, and CMake writes an argument out as it
# was given. The build's own DEPENDS names the files, so an edit still rebuilds.
file(GLOB SOURCES "${SRC_DIR}/*.c")

# Pass one: which class each member table belongs to. A registration wraps
# over as many lines as it needs, so it is accumulated until it closes.
foreach(_src IN LISTS SOURCES)
    file(STRINGS "${_src}" _lines)
    set(_acc "")
    foreach(_line IN LISTS _lines)
        if(_acc STREQUAL "")
            if(NOT _line MATCHES "BTA_CLASS")
                continue()
            endif()
            set(_acc "${_line}")
        else()
            string(APPEND _acc " ${_line}")
        endif()

        if(_acc MATCHES "\\)[ \t]*,?[ \t]*$")
            if(_acc MATCHES "BTA_CLASS[A-Z_]*[ \t]*\\([ \t]*\"([A-Za-z_][A-Za-z0-9_]*)\"[ \t]*,[ \t]*(\"[A-Za-z_][A-Za-z0-9_]*\"|NULL)[ \t]*,[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*,[ \t]*([A-Za-z_][A-Za-z0-9_]*)")
                set(_class "${CMAKE_MATCH_1}")
                set(_table "${CMAKE_MATCH_3}")
                if(_table STREQUAL "base")
                    set(_table "widget_props")
                endif()
                list(APPEND _owners "${_table}=${_class}")
            endif()
            set(_acc "")
        endif()
    endforeach()
endforeach()

# Pass two: the signatures, in source order.
foreach(_src IN LISTS SOURCES)
    file(STRINGS "${_src}" _lines)
    set(_table "")
    set(_pending "")

    foreach(_line IN LISTS _lines)
        # A signature comment: one line, the whole of it.
        if(_line MATCHES "^[ \t]*/\\*[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\\(([^)]*)\\)[ \t]*\\*/[ \t]*$")
            list(APPEND _pending "${CMAKE_MATCH_1}|(${CMAKE_MATCH_2})")
            continue()
        endif()

        # A table of members: what a following entry belongs to.
        if(_line MATCHES "^[ \t]*static const JSCFunctionListEntry[ \t]+([A-Za-z_][A-Za-z0-9_]*)\\[\\][ \t]*=")
            set(_table "${CMAKE_MATCH_1}")
            set(_pending "")
            continue()
        endif()

        # A class row: every comment still pending is one of its events.
        if(_line MATCHES "BTA_CLASS[A-Z_]*[ \t]*\\([ \t]*\"([A-Za-z_][A-Za-z0-9_]*)\"")
            set(_class "${CMAKE_MATCH_1}")
            foreach(_sig IN LISTS _pending)
                string(REPLACE "|" ";" _parts "${_sig}")
                list(GET _parts 0 _member)
                list(GET _parts 1 _args)
                list(APPEND _entries "${_class}|${_member}|${_args}|true")
            endforeach()
            set(_pending "")
            continue()
        endif()

        # A member: the comment directly above it, when it names it.
        if(_line MATCHES "JS_CFUNC(_MAGIC)?_DEF[ \t]*\\([ \t]*\"([A-Za-z_][A-Za-z0-9_]*)\"")
            set(_member "${CMAKE_MATCH_2}")
            if(_pending)
                list(GET _pending -1 _sig)
                string(REPLACE "|" ";" _parts "${_sig}")
                list(GET _parts 0 _named)
                list(GET _parts 1 _args)
                if(_named STREQUAL _member AND NOT _table STREQUAL "")
                    foreach(_owner IN LISTS _owners)
                        if(_owner MATCHES "^${_table}=(.*)$")
                            list(APPEND _entries "${CMAKE_MATCH_1}|${_member}|${_args}|false")
                        endif()
                    endforeach()
                endif()
            endif()
            set(_pending "")
            continue()
        endif()

        # Anything else ends the adjacency: a signature comment documents what
        # is on the next line, and a blank line or a prose comment in between
        # means the next entry has none.
        if(NOT _line STREQUAL "")
            set(_pending "")
        endif()
    endforeach()
endforeach()

set(_out "/* Generated from the C sources under runtime/src -- do not edit.\n")
string(APPEND _out " *\n")
string(APPEND _out " * The parameters every method and event declares beside itself, as\n")
string(APPEND _out " * `Widget.Signature(type, name)` answers them. `event` tells the two\n")
string(APPEND _out " * apart where a name is both, which `Button.Click` is.\n")
string(APPEND _out " */\n")
string(APPEND _out "typedef struct {\n")
string(APPEND _out "    const char *owner;\n")
string(APPEND _out "    const char *member;\n")
string(APPEND _out "    const char *signature;\n")
string(APPEND _out "    bool        event;\n")
string(APPEND _out "} BtaSignature;\n\n")
string(APPEND _out "static const BtaSignature bta_signatures[] = {\n")

foreach(_entry IN LISTS _entries)
    string(REPLACE "|" ";" _parts "${_entry}")
    list(GET _parts 0 _owner)
    list(GET _parts 1 _member)
    list(GET _parts 2 _args)
    list(GET _parts 3 _event)
    string(APPEND _out "    { \"${_owner}\", \"${_member}\", \"${_args}\", ${_event} },\n")
endforeach()

string(APPEND _out "};\n")

file(WRITE "${OUTPUT}" "${_out}")
