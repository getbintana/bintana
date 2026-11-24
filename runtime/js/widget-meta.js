/*
 * The widget metadata, as data and not as a linked toolkit.
 *
 * `bintana-meta --dump` writes `widgets.json` from the real class rows, their
 * property tables and both prelude halves. This file loads that document and
 * gives the console host the `Widget.*` answers a check asks -- no class can be
 * built, and `Widget.New` says so.
 *
 * It is a script, and the host sets `WidgetDataPath` before evaluating it. It
 * is loaded only for `check`; a `main` that never asks for a widget never sees
 * `Widget` at all.
 */
"use strict";

const widgetData = File.LoadJson(globalThis.WidgetDataPath);
/* Read now: by the time a check asks, `globalThis` is sealed off. */
const apiPath = globalThis.WidgetDataPath.slice(0, -"widgets.json".length) + "api.json";

function widgetClass(type) {
    if (!Dictionary.Has(widgetData.Members, type))
        throw new TypeError(`'${type}' is not a widget class`);
    return widgetData.Members[type];
}

/*
 * **The globals' members, from `api.json`** -- `Database`, `File`, `Http` and
 * the value types (`HttpClient`, `Key`, ...). The graphical host answers
 * `Widget.Members("Database")` by walking the live object; this host cannot,
 * because several of its globals are the console's subset or an empty stub
 * (`Text` has `LineOf` only, `Printer` `Papers`, the GUI globals nothing), and
 * a walk would call `Text.Width` a mistake in a project that opens a window.
 * `api.json` is that walk, written by the graphical host and held to it by
 * `tests/api.sh`, so the check's `Database.Open` finding -- the first thing a
 * person new to the runtime gets wrong -- reaches `bintana check` too.
 *
 * Read on the first question and not at load: a check that never asks pays
 * nothing for a megabyte of JSON. Missing (a build that did not copy it) is
 * the old answer, a refusal, and the finding stays quiet rather than wrong.
 */
let globalData = null;

function globalMembers(type) {
    if (globalData === null) {
        globalData = {};
        if (File.Exists(apiPath)) {
            const api = File.LoadJson(apiPath);
            for (const g of (api.Types || []).concat(api.Globals || []))
                if (g && g.Name && g.Members) globalData[g.Name] = g.Members;
        }
    }
    if (!Dictionary.Has(globalData, type))
        throw new TypeError(`'${type}' is not a class the runtime knows`);
    return globalData[type];
}

const Widget = {
    Types() {
        return widgetData.Types.slice();
    },

    Members(type) {
        if (!Dictionary.Has(widgetData.Members, type))
            return globalMembers(type).slice();
        return widgetClass(type).slice();
    },

    Member(type, name) {
        for (const m of widgetClass(type))
            if (m.Name === name)
                return m.Kind;
        return "";
    },

    Signature(type, name) {
        if (!Dictionary.Has(widgetData.Members, type))
            throw new TypeError(`'${type}' is not a widget class`);
        return Dictionary.Has(widgetData.Signatures[type], name)
                   ? widgetData.Signatures[type][name] : null;
    },

    EventSignature(type, name) {
        if (!Dictionary.Has(widgetData.Members, type))
            throw new TypeError(`'${type}' is not a widget class`);
        return Dictionary.Has(widgetData.EventSignatures[type], name)
                   ? widgetData.EventSignatures[type][name] : null;
    },

    EventDoc(type, name) {
        if (!Dictionary.Has(widgetData.Members, type))
            throw new TypeError(`'${type}' is not a widget class`);
        return Dictionary.Has(widgetData.EventDocs[type], name)
                   ? widgetData.EventDocs[type][name] : null;
    },

    PropertyNames(type) {
        return widgetClass(type).length
                   ? (widgetData.PropertyNames[type] || []).slice() : [];
    },

    Methods(type) {
        return widgetClass(type).length
                   ? (widgetData.Methods[type] || []).slice() : [];
    },

    EventNames(type) {
        return widgetClass(type).length
                   ? (widgetData.EventNames[type] || []).slice() : [];
    },

    TextProperties(type) {
        return widgetClass(type).length
                   ? (widgetData.TextProperties[type] || []).slice() : [];
    },

    PropertyOptions(type, prop) {
        widgetClass(type);
        const options = widgetData.PropertyOptions[type];
        return Dictionary.Has(options, prop) ? options[prop] : null;
    },

    DeferredProperties(type) {
        return widgetClass(type).length
                   ? (widgetData.DeferredProperties[type] || []).slice() : [];
    },

    Available(type) {
        return Dictionary.Has(widgetData.Available, type)
                   ? !!widgetData.Available[type] : false;
    },

    New(type) {
        throw new TypeError(`the console host cannot build a widget (${type})`);
    },
};

/*
 * `Application.Globals()` sees the names the check's name pass reads, but a
 * class here is a name and nothing else. Constructing one is the sentence
 * `Widget.New` gives.
 */
for (const type of widgetData.Types) {
    if (type === "Widget") continue;
    globalThis[type] = function () {
        throw new TypeError(`the console host cannot build a widget (${type})`);
    };
}

globalThis.Widget = Widget;
