# Turns a text file into a C string literal header.
#   cmake -DINPUT=x.js -DOUTPUT=x.h -DSYMBOL=foo -P embed_text.cmake

file(READ ${INPUT} _raw)

# Escape in an order that never re-escapes its own output.
string(REPLACE "\\" "\\\\" _raw "${_raw}")
string(REPLACE "\"" "\\\"" _raw "${_raw}")
string(REPLACE "\n" "\\n\"\n\"" _raw "${_raw}")

get_filename_component(_name ${INPUT} NAME)
set(_out "/* Generated from ${_name} -- do not edit. */\n")
set(_out "${_out}static const char ${SYMBOL}[] =\n\"${_raw}\";\n")

file(WRITE ${OUTPUT} "${_out}")
