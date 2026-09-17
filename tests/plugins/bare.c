/*
 * A shared object that is not a plugin: it exists so the suite can watch the
 * loader refuse a `<name>.so` with no `bta_plugin` in it, and say so by name.
 * Its one export is deliberately something else.
 */
#include "bta_plugin.h"

BTA_PLUGIN_EXPORT int testplug_not_a_plugin(void)
{
    return 1;
}
