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
# **A global's members are declared the same way**, and their owner is not in
# any class row, so it is worked out from the C that installs them:
#
#     /* Load(path) */
#     JS_SetPropertyStr(ctx, file, "Load", JS_NewCFunction(...));
#     ...
#     JS_SetPropertyStr(ctx, global, "File", file);
#
# makes the owner `File`. A table installed with `JS_SetPropertyFunctionList`
# on a variable is owned the same way, a prototype joined to a constructor with
# `JS_SetConstructor` is owned by the constructor's name, and a variable hung
# off another (`Desktop.Entries`) is owned by the dotted path. Variables are
# scoped by the C function they are in -- a line that is exactly `{` opens one
# -- because every file reuses `proto` and `ctor`. The one variable no
# installation names is the root widget class's constructor, which the class
# table loop hands to `Widget` by computing its name; `VAR_ALIASES` is that line.
#
# **What a call answers is declared on the same line**, after an arrow:
#
#     /* Info(path) -> { Size, Modified, Type, Icon, IsDir } */
#     /* LoadBytes(path) -> Bytes */
#     /* Files(path, [options]) -> string[] */
#
# a type the runtime can be asked about by name, `string`/`number`/`boolean`,
# any of those followed by `[]`, or a shape in braces. A property can declare
# the same with no brackets -- `/* Children -> Widget[] */` above its
# `JS_CGETSET_DEF`. It is what lets the IDE complete past a call
# (`File.Info(p).`), and it is a claim, so it is written where the function is.
#
# **A prototype no global names is named where its table is**:
#
#     /* type HttpClient */
#     static const JSCFunctionListEntry http_client_props[] = {
#
# and then every entry of that table is listed under the name, commented or not
# and properties included -- `Widget.Members("HttpClient")` has no object to
# walk, so this table is the whole answer about it.
#
# **And what the member is for, in the same comment**, on the lines after the
# first, indented:
#
#     /* Load(path) -> string
#      *   The file's text. A file that is not UTF-8 answers U+FFFD rather than
#      *   refusing; `LoadBytes` is how to tell.
#      */
#
# and for a property the first line is its name alone, or its name and an
# arrow. That text is the one description a member has: `Widget.Members` hands
# it to the IDE's completion as `Doc`, and `tools/docs` writes it into the rows
# of `docs/llm` and `docs/reference`, so the documentation of a member lives
# where the member is and nowhere else. A blank line (` *`) is a paragraph.
#
# The output is a C table and not a JS one so the runtime can publish it with
# no control built and no display: `Widget.Signature(type, name)`, and the
# `Signature` of each member `Widget.Members` lists.

set(_owners "")     # table name -> class name
set(_entries "")    # "owner|member|signature|returns|kind|doc" in source order
set(_rawtables "")  # "table|member|signature|returns|kind|doc" no class row owns
set(_rawvars "")    # "file:scope:var|member|signature|returns|kind|doc"
set(_typetables "") # "table=Name" -- a table named by a `/* type Name */`
set(_edges "")      # "file:scope:var=parent|Name" -- var installed as parent.Name
set(_tabvars "")    # "table=file:scope:var" -- a table installed on a var
set(_protos "")     # "file:scope:proto=file:scope:ctor" -- JS_SetConstructor
set(VAR_ALIASES "bta_widget.c:ctor=Widget")

# The sources are globbed here rather than listed on the command line: a list
# has a separator the shell would eat, and CMake writes an argument out as it
# was given. The build's own DEPENDS names the files, so an edit still rebuilds.
file(GLOB SOURCES "${SRC_DIR}/*.c")

# **Every line, and only lines.** `file(STRINGS)` hands back a CMake list, and a
# list treats `[` ... `]` as grouping and `;` as a separator -- so one unbalanced
# bracket in a C file (`*q == '['`) merged every line after it into one item,
# and the signatures below it vanished with the build green. The text is read
# whole with the characters a list or a record would misread swapped for
# markers first, split on newlines, and the markers put back only in what is
# written out. `|` is the separator of the records below, so a description
# that says `a | b` is marked too.
macro(bta_read_lines path out)
    file(READ "${path}" _text)
    string(REPLACE "[" "<LB>" _text "${_text}")
    string(REPLACE "]" "<RB>" _text "${_text}")
    string(REPLACE ";" "<SC>" _text "${_text}")
    string(REPLACE "\\" "<BS>" _text "${_text}")
    string(REPLACE "|" "<PI>" _text "${_text}")
    string(REPLACE "\n" ";" ${out} "${_text}")
endmacro()

macro(bta_unmark var)
    string(REPLACE "<LB>" "[" ${var} "${${var}}")
    string(REPLACE "<RB>" "]" ${var} "${${var}}")
    string(REPLACE "<SC>" ";" ${var} "${${var}}")
    string(REPLACE "<BS>" "\\" ${var} "${${var}}")
    string(REPLACE "<PI>" "|" ${var} "${${var}}")
endmacro()

# `-` stands for an empty field: a list element that is empty is one CMake
# does not reliably keep.
macro(bta_dash var)
    if("${${var}}" STREQUAL "")
        set(${var} "-")
    endif()
endmacro()

# Pass one: which class each member table belongs to. A registration wraps
# over as many lines as it needs, so it is accumulated until it closes.
foreach(_src IN LISTS SOURCES)
    bta_read_lines("${_src}" _lines)
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

# Pass two: the declarations, in source order, and where every variable goes.
#
# A pending declaration is "name|args|returns|doc": `args` is `(…)` for a call
# and `@` for a property, and whatever is `-` was not written.
foreach(_src IN LISTS SOURCES)
    bta_read_lines("${_src}" _lines)
    get_filename_component(_fid "${_src}" NAME)
    set(_table "")
    set(_pending "")
    set(_scope 0)
    set(_block "")      # the declaration a multi-line comment opened, if any
    set(_doc "")

    foreach(_line IN LISTS _lines)
        # Inside a declaration's comment: its lines are the description, and
        # its closing line makes it pending like a one-line one.
        if(NOT _block STREQUAL "")
            if(_line MATCHES "^[ \t]*\\*/[ \t]*$")
                string(STRIP "${_doc}" _doc)
                bta_dash(_doc)
                list(APPEND _pending "${_block}|${_doc}")
                set(_block "")
                continue()
            endif()
            if(_line MATCHES "^[ \t]*\\*[ \t]?(.*)$")
                string(STRIP "${CMAKE_MATCH_1}" _t)
                set(_closes FALSE)
                if(_t MATCHES "^(.*)\\*/$")
                    string(STRIP "${CMAKE_MATCH_1}" _t)
                    set(_closes TRUE)
                endif()
                if(_t STREQUAL "")
                    string(APPEND _doc "<NL>")
                elseif(_doc STREQUAL "" OR _doc MATCHES "<NL>$")
                    string(APPEND _doc "${_t}")
                else()
                    string(APPEND _doc " ${_t}")
                endif()
                if(_closes)
                    string(STRIP "${_doc}" _doc)
                    bta_dash(_doc)
                    list(APPEND _pending "${_block}|${_doc}")
                    set(_block "")
                endif()
                continue()
            endif()
            # Anything else was not a declaration's comment after all.
            set(_block "")
        endif()

        # A function body opens at column zero, and every variable name after
        # it belongs to that body.
        if(_line STREQUAL "{")
            math(EXPR _scope "${_scope} + 1")
            set(_table "")
            set(_pending "")
            continue()
        endif()

        # A declaration's comment, one line: the signature, and what the call
        # answers after an arrow.
        if(_line MATCHES "^[ \t]*/\\*[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\\(([^)]*)\\)[ \t]*(->[ \t]*(.*[^ \t]))?[ \t]*\\*/[ \t]*$")
            set(_sigargs "${CMAKE_MATCH_2}")
            set(_sigret "${CMAKE_MATCH_4}")
            bta_dash(_sigret)
            list(APPEND _pending "${CMAKE_MATCH_1}|(${_sigargs})|${_sigret}|-")
            continue()
        endif()
        # ...a property's, one line: a name, an arrow, and no brackets.
        if(_line MATCHES "^[ \t]*/\\*[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*->[ \t]*(.*[^ \t])[ \t]*\\*/[ \t]*$")
            list(APPEND _pending "${CMAKE_MATCH_1}|@|${CMAKE_MATCH_2}|-")
            continue()
        endif()
        # ...and the first line of one that goes on, with a description after.
        if(NOT _line MATCHES "\\*/")
            if(_line MATCHES "^[ \t]*/\\*[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\\(([^)]*)\\)[ \t]*(->[ \t]*(.*[^ \t]))?[ \t]*$")
                set(_sigret "${CMAKE_MATCH_4}")
                bta_dash(_sigret)
                set(_block "${CMAKE_MATCH_1}|(${CMAKE_MATCH_2})|${_sigret}")
                set(_doc "")
                continue()
            endif()
            if(_line MATCHES "^[ \t]*/\\*[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*(->[ \t]*(.*[^ \t]))?[ \t]*$")
                set(_sigret "${CMAKE_MATCH_3}")
                bta_dash(_sigret)
                set(_block "${CMAKE_MATCH_1}|@|${_sigret}")
                set(_doc "")
                continue()
            endif()
        endif()

        # A name for the table below: a prototype no global installs.
        if(_line MATCHES "^[ \t]*/\\*[ \t]*type[ \t]+([A-Za-z_][A-Za-z0-9_.]*)[ \t]*\\*/[ \t]*$")
            set(_nexttype "${CMAKE_MATCH_1}")
            continue()
        endif()

        # A table of members: what a following entry belongs to.
        if(_line MATCHES "^[ \t]*static const JSCFunctionListEntry[ \t]+([A-Za-z_][A-Za-z0-9_]*)<LB><RB>[ \t]*=")
            set(_table "${CMAKE_MATCH_1}")
            if(NOT "${_nexttype}" STREQUAL "")
                list(APPEND _typetables "${_table}=${_nexttype}")
            endif()
            set(_nexttype "")
            set(_pending "")
            continue()
        endif()
        if(NOT _line STREQUAL "" AND NOT _line MATCHES "^[ \t]*/\\*")
            set(_nexttype "")
        endif()

        # Where a variable, a table or a prototype ends up. None of these is a
        # member, so none of them consumes a pending comment -- and none ends
        # the adjacency either, since they are never what a comment documents.
        if(_line MATCHES "JS_SetPropertyFunctionList[ \t]*\\([ \t]*ctx[ \t]*,[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*,[ \t]*([A-Za-z_][A-Za-z0-9_]*)")
            list(APPEND _tabvars "${CMAKE_MATCH_2}=${_fid}:${_scope}:${CMAKE_MATCH_1}")
        endif()
        if(_line MATCHES "JS_SetConstructor[ \t]*\\([ \t]*ctx[ \t]*,[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*,[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\\)")
            list(APPEND _protos "${_fid}:${_scope}:${CMAKE_MATCH_2}=${_fid}:${_scope}:${CMAKE_MATCH_1}")
        endif()
        if(_line MATCHES "JS_SetPropertyStr[ \t]*\\([ \t]*ctx[ \t]*,[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*,[ \t]*\"([A-Za-z_][A-Za-z0-9_]*)\"[ \t]*,[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\\)")
            list(APPEND _edges "${_fid}:${_scope}:${CMAKE_MATCH_3}=${CMAKE_MATCH_1}|${CMAKE_MATCH_2}")
        endif()

        # A class row: every comment still pending is one of its events.
        if(_line MATCHES "BTA_CLASS[A-Z_]*[ \t]*\\([ \t]*\"([A-Za-z_][A-Za-z0-9_]*)\"")
            set(_class "${CMAKE_MATCH_1}")
            foreach(_sig IN LISTS _pending)
                string(REPLACE "|" ";" _parts "${_sig}")
                list(GET _parts 0 _member)
                list(GET _parts 1 _args)
                list(GET _parts 3 _sdoc)
                if(NOT _args STREQUAL "@")
                    list(APPEND _entries "${_class}|${_member}|${_args}|-|event|${_sdoc}")
                endif()
            endforeach()
            set(_pending "")
            continue()
        endif()

        # A member of a table: the comment directly above it, when it names it
        # -- and every member of a table a `/* type */` named, with or without
        # one, since that table is the whole of what the type can be asked.
        set(_kind "")
        if(_line MATCHES "JS_CFUNC(_MAGIC)?_DEF2?[ \t]*\\([ \t]*\"([A-Za-z_][A-Za-z0-9_]*)\"")
            set(_member "${CMAKE_MATCH_2}")
            set(_kind "method")
        elseif(_line MATCHES "JS_CGETSET(_MAGIC)?_DEF2?[ \t]*\\([ \t]*\"([A-Za-z_][A-Za-z0-9_]*)\"")
            set(_member "${CMAKE_MATCH_2}")
            set(_kind "property")
        endif()
        if(NOT _kind STREQUAL "" AND NOT _table STREQUAL "")
            set(_args "-")
            set(_ret "-")
            set(_mdoc "-")
            set(_said FALSE)
            if(_pending)
                list(GET _pending -1 _sig)
                string(REPLACE "|" ";" _parts "${_sig}")
                list(GET _parts 0 _named)
                list(GET _parts 1 _sargs)
                list(GET _parts 2 _sret)
                list(GET _parts 3 _sdoc)
                if(_named STREQUAL _member)
                    if(_kind STREQUAL "method" AND NOT _sargs STREQUAL "@")
                        set(_args "${_sargs}")
                        set(_said TRUE)
                    elseif(_kind STREQUAL "property" AND _sargs STREQUAL "@")
                        set(_said TRUE)
                    endif()
                    if(_said)
                        set(_ret "${_sret}")
                        set(_mdoc "${_sdoc}")
                    endif()
                endif()
            endif()

            set(_typed "")
            foreach(_tt IN LISTS _typetables)
                if(_tt MATCHES "^${_table}=(.*)$")
                    set(_typed "${CMAKE_MATCH_1}")
                endif()
            endforeach()

            if(NOT _typed STREQUAL "")
                list(APPEND _entries "${_typed}|${_member}|${_args}|${_ret}|${_kind}|${_mdoc}")
            elseif(_said)
                set(_found FALSE)
                foreach(_owner IN LISTS _owners)
                    if(_owner MATCHES "^${_table}=(.*)$")
                        list(APPEND _entries "${CMAKE_MATCH_1}|${_member}|${_args}|${_ret}|${_kind}|${_mdoc}")
                        set(_found TRUE)
                    endif()
                endforeach()
                if(NOT _found)
                    list(APPEND _rawtables "${_table}|${_member}|${_args}|${_ret}|${_kind}|${_mdoc}")
                endif()
            endif()
            set(_pending "")
            continue()
        endif()

        # A member set on a variable: the same adjacency, and the variable is
        # named once every installation in the tree has been read. A
        # property's comment makes it a property -- `Application.Directory`
        # is a value and not a call.
        if(_line MATCHES "^[ \t]*JS_SetPropertyStr[ \t]*\\([ \t]*ctx[ \t]*,[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*,[ \t]*\"([A-Za-z_][A-Za-z0-9_]*)\"")
            set(_var "${CMAKE_MATCH_1}")
            set(_member "${CMAKE_MATCH_2}")
            if(_pending)
                list(GET _pending -1 _sig)
                string(REPLACE "|" ";" _parts "${_sig}")
                list(GET _parts 0 _named)
                list(GET _parts 1 _args)
                list(GET _parts 2 _ret)
                list(GET _parts 3 _sdoc)
                if(_named STREQUAL _member)
                    if(_args STREQUAL "@")
                        list(APPEND _rawvars "${_fid}:${_scope}:${_var}|${_member}|-|${_ret}|property|${_sdoc}")
                    else()
                        list(APPEND _rawvars "${_fid}:${_scope}:${_var}|${_member}|${_args}|${_ret}|method|${_sdoc}")
                    endif()
                endif()
            endif()
            set(_pending "")
            continue()
        endif()

        # A database driver is installed by a helper that hangs it off
        # `Database`, so the helper's own call is the member line.
        if(_line MATCHES "^[ \t]*bta_database_driver[ \t]*\\([ \t]*ctx[ \t]*,[ \t]*\"([A-Za-z_][A-Za-z0-9_]*)\"")
            set(_member "${CMAKE_MATCH_1}")
            if(_pending)
                list(GET _pending -1 _sig)
                string(REPLACE "|" ";" _parts "${_sig}")
                list(GET _parts 0 _named)
                list(GET _parts 1 _args)
                list(GET _parts 2 _ret)
                list(GET _parts 3 _sdoc)
                if(_named STREQUAL _member)
                    list(APPEND _entries "Database|${_member}|${_args}|${_ret}|method|${_sdoc}")
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

# Pass three: name every variable that holds members.
#
# `file:scope:var` is installed as `parent.Name`; a parent of `global` is the
# top, a prototype takes its constructor's name, and the alias list names the
# one constructor no line does. Recursive, and bounded, because a C file that
# installed a variable on itself would otherwise loop here.
function(bta_name_of key depth out)
    set(${out} "" PARENT_SCOPE)
    if(depth GREATER 8)
        return()
    endif()
    math(EXPR _next "${depth} + 1")
    string(REGEX REPLACE ":[^:]*:[^:]*$" "" _file "${key}")
    string(REGEX REPLACE "^.*:" "" _var "${key}")
    string(REGEX REPLACE ":[^:]*$" "" _fs "${key}")
    foreach(_e IN LISTS _edges)
        if(_e MATCHES "^([^=]*)=([^|]*)\\|(.*)$" AND CMAKE_MATCH_1 STREQUAL key)
            set(_parent "${CMAKE_MATCH_2}")
            set(_name "${CMAKE_MATCH_3}")
            if(_parent STREQUAL "global")
                set(${out} "${_name}" PARENT_SCOPE)
                return()
            endif()
            bta_name_of("${_fs}:${_parent}" ${_next} _up)
            if(NOT _up STREQUAL "")
                set(${out} "${_up}.${_name}" PARENT_SCOPE)
                return()
            endif()
        endif()
    endforeach()
    foreach(_p IN LISTS _protos)
        if(_p MATCHES "^([^=]*)=(.*)$" AND CMAKE_MATCH_1 STREQUAL key)
            bta_name_of("${CMAKE_MATCH_2}" ${_next} _up)
            if(NOT _up STREQUAL "")
                set(${out} "${_up}" PARENT_SCOPE)
                return()
            endif()
        endif()
    endforeach()
    foreach(_a IN LISTS VAR_ALIASES)
        if(_a MATCHES "^([^=]*)=(.*)$" AND CMAKE_MATCH_1 STREQUAL "${_file}:${_var}")
            set(${out} "${CMAKE_MATCH_2}" PARENT_SCOPE)
            return()
        endif()
    endforeach()
endfunction()

foreach(_r IN LISTS _rawvars)
    string(REPLACE "|" ";" _parts "${_r}")
    list(GET _parts 0 _key)
    list(GET _parts 1 _member)
    list(GET _parts 2 _args)
    list(GET _parts 3 _ret)
    list(GET _parts 4 _kind)
    list(GET _parts 5 _rdoc)
    bta_name_of("${_key}" 0 _owner)
    if(NOT _owner STREQUAL "")
        list(APPEND _entries "${_owner}|${_member}|${_args}|${_ret}|${_kind}|${_rdoc}")
    endif()
endforeach()

foreach(_r IN LISTS _rawtables)
    string(REPLACE "|" ";" _parts "${_r}")
    list(GET _parts 0 _tab)
    list(GET _parts 1 _member)
    list(GET _parts 2 _args)
    list(GET _parts 3 _ret)
    list(GET _parts 4 _kind)
    list(GET _parts 5 _rdoc)
    foreach(_tv IN LISTS _tabvars)
        if(_tv MATCHES "^${_tab}=(.*)$")
            bta_name_of("${CMAKE_MATCH_1}" 0 _owner)
            if(NOT _owner STREQUAL "")
                list(APPEND _entries "${_owner}|${_member}|${_args}|${_ret}|${_kind}|${_rdoc}")
            endif()
        endif()
    endforeach()
endforeach()
list(REMOVE_DUPLICATES _entries)

set(_out "/* Generated from the C sources under runtime/src -- do not edit.\n")
string(APPEND _out " *\n")
string(APPEND _out " * What every method, event and property declares beside itself: its\n")
string(APPEND _out " * parameters, what it answers and what it is for. `Widget.Signature` and\n")
string(APPEND _out " * `Widget.Members` publish it, and a type named by a `type X` comment is\n")
string(APPEND _out " * answered from here alone, since no global holds it.\n")
string(APPEND _out " */\n")
string(APPEND _out "typedef enum { BTA_SIG_METHOD, BTA_SIG_EVENT, BTA_SIG_PROPERTY } BtaSigKind;\n\n")
string(APPEND _out "typedef struct {\n")
string(APPEND _out "    const char *owner;\n")
string(APPEND _out "    const char *member;\n")
string(APPEND _out "    const char *signature;\n")
string(APPEND _out "    const char *returns;\n")
string(APPEND _out "    BtaSigKind  kind;\n")
string(APPEND _out "    const char *doc;\n")
string(APPEND _out "} BtaSignature;\n\n")
string(APPEND _out "static const BtaSignature bta_signatures[] = {\n")

# Written as a C string: the markers go back, a backslash and a quote are
# escaped, and a paragraph break is a newline.
macro(bta_c_string var)
    bta_unmark(${var})
    string(REPLACE "\\" "\\\\" ${var} "${${var}}")
    string(REPLACE "\"" "\\\"" ${var} "${${var}}")
    string(REPLACE "<NL>" "\\n" ${var} "${${var}}")
endmacro()

foreach(_entry IN LISTS _entries)
    string(REPLACE "|" ";" _parts "${_entry}")
    list(GET _parts 0 _owner)
    list(GET _parts 1 _member)
    list(GET _parts 2 _args)
    list(GET _parts 3 _ret)
    list(GET _parts 4 _kind)
    list(GET _parts 5 _edoc)
    foreach(_v _args _ret _edoc)
        if("${${_v}}" STREQUAL "-")
            set(${_v} "")
        endif()
    endforeach()
    bta_c_string(_args)
    bta_c_string(_ret)
    bta_c_string(_edoc)
    string(TOUPPER "${_kind}" _k)
    string(APPEND _out "    { \"${_owner}\", \"${_member}\", \"${_args}\", \"${_ret}\", BTA_SIG_${_k}, \"${_edoc}\" },\n")
endforeach()

string(APPEND _out "};\n")

file(WRITE "${OUTPUT}" "${_out}")
