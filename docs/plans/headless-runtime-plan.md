# Un runtime sin GTK: el host de consola

**Estado: Fase 0 medida y Fase 1 probada (2026-11-12), y Fase 2 en curso**:
`bintana-headless --version`, `check` y el `main` de un proyecto corren sin GTK,
con la misma salida que el runtime gráfico, y un proyecto `startup` se ejecuta
como el host gráfico. Lo que falta de Fase 2 es la instalación.
El spike está en [`docs/notes/headless-runtime.md`](../notes/headless-runtime.md):
`bintana-meta` compila las filas de clases con stubs, no enlaza GTK, carga
`forms.js` con los diez captures de `rad.js`, y sus respuestas coinciden con
las del runtime gráfico en `Types`, `PropertyNames` (con `DataField`),
`Methods`, `Members` (con `Doc`), eventos, firmas, textos, opciones, diferidos
y `Available`.

**La distribución espera su Fase 1**:
[`distribution-plan.md`](distribution-plan.md) no fija los nombres ni las
dependencias de los paquetes hasta que la prueba de metadata diga cómo se
reparte el runtime. **La respuesta es dos hosts, y dos binarios instalados está
bien:** uno de consola que **no enlaza ni carga GTK/GtkSourceView/VTE**, y uno
gráfico que sí. **Lo que no se quiere es un tercer binario que exista solo para
`check` y las herramientas de test**, porque ese es un rol del host de consola.
El comando `bintana <proyecto>` sigue funcionando para los dos: el host de consola
lee `project.btp` y, si el proyecto declara `startup`, ejecuta el host gráfico.
`bintana check`, `--version` y los proyectos `main` corren en el host de consola.

**No es un plan para hacer más chico el lenguaje.** Un proyecto `main` conserva
los mismos nombres de globals que hoy; los que necesitan una ventana responden
con una frase ("no display") en vez de desaparecer. La excepción, si el dueño la
aprueba, es `forms.js`: el host de consola puede cargarlo solo para metadata o no
cargarlo, y eso cambia lo que `Widget.Members` responde (ver Fase 1).

**El límite es GTK, no "gráficos".** Un `main` puede escribir un PDF con logo y
gráfico sin display (el `testDocument` de `tests/report` lo hace), con cairo,
Pango, gdk-pixbuf y PoDoFo. Eso se queda en el core. Lo que se va es el toolkit de
ventanas.

## Lo que hay hoy

- Un proyecto `main` **no inicializa** GTK (`docs/architecture.md:171-191`,
  `docs/agents/runtime.md:152-160`), pero el binario **lo enlaza**: en Windows el
  loader resuelve la tabla de imports antes de `main`, y en Linux el loader mapea
  las `.so` al arrancar. `--version`, `check`, `tests/icons`, `tests/styles` y
  `tests/media` pagan ese peaje.
- `install_globals()` instala **todas** las globals, widgets incluidos, evalúa
  `rad.js` y `forms.js`, y `run_console()` lo llama para un `main`
  (`runtime/src/bta_runtime.c:2351`, `2798`, `2843-2853`, `4086-4091`).
- `BtaClass` mezcla metadata (`name`, `parent`, `options`, `texts`, `events`,
  `deferred`, `available`, `probe`) con implementación (`build`, `props`)
  (`runtime/include/bta.h:457`). `bta_widgets_init()` crea un prototipo JS por
  clase y le instala los `props` (`runtime/src/bta_widget.c:10326`).
- `Widget.Members` **camina los prototipos JS**, no las filas C
  (`runtime/src/bta_widget.c:4087-4237`). Los nombres, kinds y `Function.length`
  salen de las propiedades instaladas; los docs y las firmas salen de
  `bta_signatures.h`, generado por `tools/extract_signatures.cmake`.
- `tools/check` y `tests/api` son proyectos consola que preguntan
  `Widget.Types/Members/PropertyNames/Methods/EventNames/Signature/...`
  (`lib/check/Check.js`, `lib/check/Names.js`, `tests/api/Check.js`). Ese es el
  nudo: si se compilan fuera los widgets, se pierde la metadata que `check`
  necesita.
- El worker de `Task` ya construye un runtime headless con `rad.js` solo y un set
  curado de globals (`runtime/src/bta_task.c:1370-1545`). Es el precedente, pero
  vive en el mismo proceso: las DLLs ya están cargadas. Lo que falta es que el
  **proceso** no las cargue.
- En Windows, `bintanaw.exe` es `bintana.exe` con el subsistema PE cambiado por
  `objcopy` (`CMakeLists.txt:564-588`). El zip portable y el instalador arrancan
  `bintanaw.exe` desde los accesos directos; `bin/bintana-ide.cmd` arranca
  `bintana.exe` (`tools/windows-portable.sh:234-247`), que abre consola.

## Auditoría de archivos (punto de partida, verificar cada uno)

| archivo | destino | notas |
|---|---|---|
| `bta_runtime.c` | split | boot/carga/`run_console` al core; `GtkApplication`, alertas, iconos, `DecorationLayout` a UI |
| `bta_widget.c` | split | metadata + `Widget.*` al core; `BtaWidget`, `bta_ctor`, señales y GTK a UI |
| `bta_controls.c`, `bta_layout.c`, `bta_notebook.c`, `bta_switcher.c`, `bta_text.c`, `bta_editor.c`, `bta_terminal.c` | UI | controles y GtkSourceView/VTE |
| `bta_tree.c`, `bta_table.c`, `bta_treerows.c`, `bta_fixed.c`, `bta_menu.c` | UI | |
| `bta_paint.c` | split | `Painter` (cairo) al core; `Drawing`/`DrawingArea` a UI |
| `bta_sys.c` | split | `Exec`/`Environment`/`Process` al core; `Screen`/`Clipboard` (GDK) a UI |
| `bta_media.c` | split | `Media` (GStreamer) al core; `Video` a UI |
| `bta_form.c` | split | índice de formas y `.record` al core; instanciación de widgets a UI |
| `bta_notification.c`, `bta_notification_win32.c` | verificar | si no toca GTK, core; si toca, UI |
| `bta_tray.c`, `bta_tray_win32.c`, `bta_tray_linux.c` | UI | escritorio |
| `bta_popover.c`, `bta_desktop.c`, `bta_printer.c` | UI | GTK |
| `bta_bitmap.c`, `bta_probe.c`, `bta_pdf.c` | core | gdk-pixbuf/Poppler/PoDoFo, sin GTK |
| `bta_database.c`, `bta_sqlite.c`, `bta_xml.c`, `bta_keyring.c`, `bta_network.c`, `bta_socket.c`, `bta_serial.c` | core | |
| `bta_locale.c`, `bta_bytes.c`, `bta_decimal.c`, `bta_day.c`, `bta_http.c`, `bta_plugin.c`, `bta_task.c`, `bta_profile.c`, `bta_debug.c`, `bta_cancellable.c`, `bta_lock.c`, `bta_random.c`, `bta_gzip.c`, `bta_zip.c`, `bta_module.c`, `bta_journal.c` | core | |
| `rad.js` | core | lenguaje, `Timer`, `FormPart`, `Record`, `Settings` |
| `forms.js` | UI o core | metadata de widgets; decidir en Fase 1 |
| `base.css` | UI | |

Las filas `BTA_CLASS` viven hoy en los archivos UI. La metadata tiene que quedar
en el core o generarse; ver Fase 1.

## Fase 0 — medir y auditar (2-3 días, sin cambios de comportamiento)

**El objetivo es decidir con números, no con intuición.** Medir en Windows
(MSYS2 UCRT64) y en Linux:

- `--version`, `check` sobre `tests/smoke`, un `main` (`tests/media` o uno mínimo
  con `print`/`File.Load`/`Exec`), y un `startup` (para comparar).
- Tiempo de arranque, RSS máximo, cantidad de bibliotecas mapeadas, y tamaño del
  closure.
- En Windows: `ldd build/bintana.exe`, `objdump -p`, `Measure-Command` y
  `Get-Process ... WorkingSet64`.
- En Linux: `strace -f -e trace=openat -o /tmp/bta.trace`, `ldd`, y
  `/usr/bin/time -v`.

Entregable: `docs/notes/headless-runtime.md` con la tabla de medidas, la
auditoría de archivos confirmada y una lista de las globals que ya responden sin
display (`Message` a stderr, `Screen` en cero, `Clipboard`/`Dialog` que refusan).

**Go/no-go:** si el arranque está dominado por QuickJS/GLib y el closure de GTK
no es lo que duele, el plan no se justifica por velocidad; puede justificarse por
"no requerir GTK instalado". Decidir antes de escribir C.

## Fase 1 — separar metadata de implementación (3-5 días)

**El objetivo es probar lo único que puede hacer fracasar todo lo demás: que
`Widget.*` se pueda responder sin GTK, y que `tests/api` siga pasando.**

Hay dos caminos; el spike decide:

1. **Metadata generada.** Extender `tools/extract_signatures.cmake` para emitir
   además una tabla `BtaClassMeta` (nombre, parent, options, texts, events,
   deferred, available, probe) desde las mismas filas `BTA_CLASS`. El core usa esa
   tabla y `bta_signatures`; la UI conserva las filas reales con `build`/`props`.
   Ventaja: una sola fuente, sin drift. Riesgo: el parser de CMake tiene que
   leer los argumentos de todas las variantes de macro; si no puede, el build
   falla, no se calla.
2. **Stubs y prototipos.** Compilar los archivos de widgets con `BTA_NO_GTK`,
   redefinir `JS_CGETSET_DEF`/`JS_CFUNC_DEF` para que apunten a stubs genéricos y
   poner `build = NULL`; con `-ffunction-sections -fdata-sections` y
   `--gc-sections`, el código GTK que no se usa se cae. Ventaja: conserva
   `bta_widgets_init` y los prototipos, así `Widget.Members` no cambia. Riesgo:
   una referencia viva arrastra GTK; hay que verificarlo con `nm`/`objdump` en
   cada build.

En ambos casos, el entregable es un target **`bintana-meta`** (no se instala) que:

- no enlaza `PkgConfig::GTK4` ni `GTKSOURCE`;
- responde `Widget.Types`, `PropertyNames`, `Methods`, `Members`, `EventNames`,
  `EventSignature`, `EventDoc`, `Signature`, `TextProperties`,
  `PropertyOptions`, `DeferredProperties`, `Available`, `Member`;
- pasa `tests/api` (o un subconjunto que no dependa de `forms.js`, si se decide
  no cargarlo);
- `ldd`/`objdump` no muestra GTK.

Si el camino 2 funciona, es el más barato para llegar al objetivo. Si no, el
camino 1 es el que queda.

**Spike hecho (2026-11-12): el camino 2 funciona y el camino 1 no hace falta.**
`cmake --build build --target bintana-meta` construye un binario de 3,5 MB que
enlaza **15 bibliotecas** (GLib, GIO, libc) y ninguna de GTK, GtkSourceView o
VTE; el runtime gráfico enlaza 153. Las mismas preguntas tardan 0,11 s y 46,3 MB
en `bintana` contra 0,06 s y 9,4 MB en `bintana-meta`. El detalle y los números
están en [`docs/notes/headless-runtime.md`](../notes/headless-runtime.md).

La metadata coincide: `Types`, `PropertyNames` (con `DataField`), `Methods`,
`EventNames`, `Member`, `Signature`, `EventSignature`, `TextProperties`,
`PropertyOptions`, `DeferredProperties` y `Available`. También coincide
`Members` entero, nombre, tipo, aridad, firma, retorno, `Native` y `Doc`, porque
el host corre el pase de símbolos sobre `rad.js` y `forms.js`.
`tests/headless.sh` corre el mismo `Main.js` en los dos hosts y los difea. Dos
límites quedan nombrados:

- **`SourceEditor.Language` y `.Theme`** son listas de GtkSourceView; el host
  que no la enlaza contesta `NULL` en vez de copiar una lista que envejece.
- **`Video.Available`** usa el `available` de la fila, no el probe de la
  máquina; el probe es del host gráfico.

No se generó una tabla `BtaClassMeta`: las filas, con stubs, son la única
declaración. `forms.js` se carga con los diez captures de `rad.js` y un
`FormPart` vacío; `Widget.PropertyNames` es el walk real, y el walk C queda como
fallback si el prelude no carga.

**Decisión de contrato:** sí, el host carga `forms.js`; es lo que hace que
`PropertyNames` y `Members` tengan los miembros del prelude, que es lo que el
IDE y `tests/api` leen. El `Doc` de esos miembros salió del mismo pase de
símbolos del compilador, en una versión sin la maquinaria de módulos: el core de
la Fase 2 hereda esa idea, o mueve el `bta_symbols` real.

## Fase 2 — partir boot y globals (2-4 semanas)

**Objetivo: un target que corre un `main` de verdad sin GTK.**

**Primer slice hecho (2026-11-12): `bintana-headless --version`, `check` y el
`main` de un proyecto.** Enlaza 17 bibliotecas (ninguna gráfica), **2,9 MB en
Debug** (7,4 MB con los símbolos de `RelWithDebInfo`; un paquete los strippea)
más un `widgets.json` de 1,7 MB que solo carga para `check`, y `check ide` da
la misma salida que el check gráfico con 35,5 MB contra 60,2 MB en Debug,
**32,8 contra 58,0 MB** en `RelWithDebInfo`. Corre `tools/check` y `lib/check`
como módulos, con las globals core (`File`, `Exec`, `Directory`, `Hash`,
`Locale`, `Xml`, `Network`, `Text.LineOf`, `Decimal`, `Day`, `Bytes`),
`Application` con `Symbols`/`FreeNames`/`CheckSource`/`Globals`/`LibraryPath` y
`rad.js`. **No enlaza ningún archivo de widgets:** `bintana-meta --dump` genera
`check/widgets.json` de las filas y firmas reales, y `widget-meta.js` responde
`Widget.*` sobre ese documento solo cuando corre `check`. `bta_sys.c` se compila
con `BTA_HEADLESS` y deja afuera `Screen`/`Dialog`/`Clipboard`/`File.Open`. Los
nombres gráficos que faltan (`Message`, `Printer`, `Database`, `Http`, ...) son
objetos vacíos para que `Application.Globals()` no invente "no declarado"; una
llamada a uno de ellos todavía no tiene su frase de refusal. **El boot de
proyecto es compartido:** `bta_project.c` lee `project.btp`, resuelve `uses` y
ordena las fuentes para los dos hosts, así que una librería se busca igual en
consola y en gráfico. `bintana-headless <proyecto>` corre el `main` (con los
argumentos en `Application.Arguments`), y **un `startup` se executa como el host
gráfico** con las mismas palabras, descriptores y código de salida: el tipo de
proyecto se decide leyendo el objeto de nivel superior de `project.btp`, sin
crear un contexto QuickJS, y el host se busca en `$BINTANA_GUI`, en
`bintana-gui` al lado del binario (el split instalado) o en `bintana` al lado
(el binario único del árbol). Un `main` no ve `Widget`, porque la metadata es un
documento de `check`, no un toolkit. Lo que falta de esta fase: instalar el
binario de consola. `tests/headless.sh` corre el meta-host, el check headless, el
runner, el dispatch contra un host gráfico falso, y el gráfico, y difea las
respuestas.

1. **`bta_boot.c` (core):** leer `project.btp`, resolver `sources`, `uses`,
   `main`/`startup`, construir el contexto, cargar módulos y `rad.js`. Sacar de
   `bta_runtime.c` lo que no toca GTK. `bta_app_new`/`bta_app_free` quedan acá.
   **En curso:** `bta_project.c` ya tiene el manifiesto, `uses`, la búsqueda de
   librerías y el orden de fuentes, compartidos por los dos hosts; falta mover
   el contexto y `bta_app_new`/`bta_app_free`.
2. **`bta_core_globals.c`:** la mitad core de `install_globals`: `print`,
   `Logger`, `Application` (sin iconos/decorations), `Message` (stderr sin
   display), `Locale`, `File`, `Exec`, `Environment`, `Http`, `Socket`, `Serial`,
   `Database`, `Sqlite`, `Xml`, `Decimal`, `Day`, `Bytes`, `Bitmap`, `Painter`,
   `Metrics`, `Drawing`, `PdfDocument`, `Probe`, `Keyring`, `Network`, `Gzip`,
   `Cipher`, `Zip`, `Random`, `Task`, `Lock`, `Cancellable`, `Profile`,
   `Record`, `FormPart`, `Timer`, `Settings`. Verificar cada una contra la
   auditoría de Fase 0.
3. **`bta_ui_globals.c`:** la otra mitad: `Widget`/`Form`, `Dialog`,
   `Clipboard`, `Screen`, `Notification`, `Tray`, `Printer`, `Popover`,
   `Desktop`, `Video`, `Terminal`, `SourceEditor`, y `forms.js`. Cada global
   GTK que el core conserve tiene un stub que **refusa con una frase**; ninguna
   desaparece en silencio.
4. **`bta_headless.c`:** `run_console` movido de `bta_runtime.c`, con el
   instalador core. Sin `GtkApplication`, sin `gtk_init`, sin `forms.js` si se
   decidió no cargarlo. **Hecho para `main` y `check`:** `run_project` y
   `run_check` comparten `install_core`, sin toolkit y sin metadata para un
   `main`.
5. **`bta_gui.c`:** `GtkApplication`, `on_activate`, `run_gui`, `--form`,
   `--theme`, `--text-scale`, `--rtl`, alertas, iconos.
6. **`bta_classes.c`:** filas de metadata y las funciones `Widget.*` sin GTK; la
   UI completa `build`/`props` al arrancar. Si se eligió el camino 2 de Fase 1,
   esto es solo mover `bta_widget.c` a dos archivos.

**Aceptación de Fase 2:**

- `bintana-meta` corre `tests/api` y `tests/icons`/`tests/styles`.
- Un `main` mínimo y el `testDocument` de `tests/report` corren sin GTK y
  escriben el PDF.
- `tests/media` corre en core si GStreamer queda core; si no, se documenta por
  qué va al host gráfico.
- El worker de `Task` sigue pasando sus tests; su instalador y el core no se
  duplican.
- `tests/run.sh` completo sigue verde con el binario actual.

## Fase 3 — dos hosts y dispatch (1 semana)

1. **CMake:** `bintana-core` y `bintana-ui` como object/static libraries;
   `bintana` enlaza core; `bintanaw` (Windows) / `bintana-gui` (Linux) enlaza
   core+ui. `bintana` es el host de consola y el dispatcher.
2. **Dispatch:**
   - `bintana --version` y `bintana check` → core.
   - `bintana <proyecto>` → leer `project.btp`; `main` corre en core, `startup`
     executa el host gráfico con los mismos argumentos y descriptores.
   - `bintana test` → `main` en core, `startup` en el host gráfico.
   - `--form`, `--theme`, `--text-scale`, `--rtl` → host gráfico; `--strict`,
     `--profile`, `--debug` → el host que corresponda, con `--debug` pasando
     descriptor 3 y stdin.
   - `bintana <proyecto-startup>` no debe construir un contexto QuickJS para
     descubrir el tipo; usar el parser de `project.btp` (el mismo que ya lee
     `main`/`startup`) y ser barato.
   - **Hecho en `bintana-headless`:** el dispatch executa el host con todo tal
     como llegó, se niega a execurarse a sí mismo, y `--debug` instala el
     protocolo en el core. `--strict` y `--profile` de un `main` se rechazan con
     una frase hasta que el modo estricto y el profiler sean core; en un
     `startup` se reenvían al host gráfico como cualquier otra opción.
3. **Windows:** `bintana.exe` es consola de verdad; `bintanaw.exe` es el host
   gráfico con subsistema GUI. El `objcopy` actual se mueve al target gráfico o
   se reemplaza por `-mwindows`; verificar con `objdump -p` que `bintanaw` dice
   `Windows GUI` y `bintana` `Windows CUI`.
4. **Lanzadores y empaquetado:**
   - `tools/bintana-ide.in` executa el host gráfico.
   - `tools/windows-portable.sh`: `bintana-ide.cmd` arranca `bintanaw.exe`; el
     zip copia el closure de `bintanaw` (GTK) y el de `bintana` (core). Decidir
     si son dos zips o uno; el instalador NSIS incluye los dos.
   - `lib/package/Nsis.js` ya usa `bintanaw.exe`; el payload tiene que llevar
     `bintana.exe` para los `.cmd` y `bintanaw.exe` para los accesos directos.
   - `runtime/src/bta_notification_win32.c` ya busca `bintanaw.exe`; verificar
     que el host gráfico esté al lado.
5. **Tests y CI:**
   - `tests/run.sh` sigue con `BINTANA=./build/bintana`; el dispatcher encuentra
     `bintanaw`/`bintana-gui` al lado. Agregar `BINTANA_GUI` para apuntar el host
     gráfico en un build raro.
   - `tests/runner` usa `Application.Executable`; el chequeo de "fuente más
     nueva que el binario" tiene que mirar **los dos** binarios.
   - `tests/install`, `tests/pack`, `.github/workflows/ci.yml` y
     `windows/ci/build.yml`: listas de archivos, `objdump`, smoke de los dos
     hosts.
   - `tests/alone.sh`, `tests/check.sh`, `tests/api.sh`, `tests/asan.sh`.

**Aceptación de Fase 3:** `bintana <startup>` abre la ventana; `bintana <main>`
no carga GTK; `bintana check` no carga GTK; la suite entera pasa; el zip de
Windows arranca la IDE desde `bintanaw`.

## Fase 4 — librerías, docs y limpieza (3-5 días)

- **`lib/`:** `check`, `report`, `charts`, `xlsx`, `package` en core;
  `dialog`, `markdown` (verificar) y todo lo que instancie widgets en UI. Un
  `main` que nombre una librería UI tiene que fallar al cargar con una frase que
  nombre la librería y el display, no con un `ReferenceError` en la primera
  clase.
- **Docs:** `docs/architecture.md` (boot de dos hosts), `docs/agents/runtime.md`
  (contrato de `main`: mismos nombres, refusals), `docs/agents/build-and-tools.md`
  (targets/CI), `docs/installing.md` (lanzadores de Windows), `docs/testing.md`
  (tests nuevos), y `bintana-docs`/`bintana-llm` si cambia el contrato de
  `main`, `Application.Executable` o `--form`.
- **API:** `./tools/apijson.sh`, `./tools/llms.sh`, `./tests/api.sh`.
  `api.json` es generado; no se edita a mano.
- **Limpieza:** borrar el `objcopy` viejo si ya no hace falta, el código muerto,
  y este plan cuando esté terminado (un plan terminado se borra, no se archiva).

## Criterios de aceptación finales

- `./tests/run.sh` verde, y `./tests/alone.sh`, `./tests/asan.sh`,
  `./tests/api.sh`, `./tests/check.sh`, `./tests/install.sh`, `./tests/pack.sh`.
- `./build/bintana --version` y `./build/bintana check <proyecto>` funcionan en
  una máquina **sin GTK instalado** (Linux: un contenedor sin GTK; Windows: un
  árbol staged con solo el closure core).
- `ldd ./build/bintana` / `objdump -p` no lista GTK, GtkSourceView ni VTE.
- `./build/bintana <proyecto-startup>` sigue abriendo la ventana; `bintana-ide`
  sigue funcionando.
- Las medidas de Fase 0 repetidas: arranque, RSS y tamaño del closure, antes y
  después.

## Trampas conocidas

- **`bta_widgets_init` es process-global.** Guarda prototipos y constructores en
  una tabla que un segundo runtime sobreescribiría. El dispatcher usa `exec`, no
  dos runtimes en el mismo proceso. El worker de `Task` ya depende de esto.
- **`bta_close_hatches` va después de `rad.js` y `forms.js`.** Si el core carga
  `forms.js` para metadata, el orden es el de hoy; si no, cerrar después de
  `rad.js` y no dejar nombres a medias.
- **`Widget.Members` camina prototipos JS.** No alcanza con una tabla de nombres:
  los getters/setters tienen que existir (aunque sean stubs) y conservar
  `Function.length`, o `Params`/`Signature` mienten.
- **El extractor puede callarse.** Si una fila `BTA_CLASS` cambia de forma, el
  parser de `tools/extract_signatures.cmake` puede dejar de ver miembros sin
  fallar. Leer los conteos que imprime `tests/api`; agregar un chequeo de
  cantidad si hace falta.
- **Padre antes que hijo** en la tabla de clases; cualquier tabla de metadata
  generada tiene que conservar el orden.
- **`Application.Executable` y la IDE.** Si el host gráfico responde su propio
  path, el `Run` de la IDE arranca el binario gráfico para un `main` y carga
  GTK. Decidir: responder el `bintana` dispatcher si está al lado, o aceptar el
  costo y documentarlo.
- **El runner comprueba mtime.** `tests/runner` compara las fuentes contra
  `Application.Executable`; con dos binarios, el chequeo tiene que mirar el que
  corresponde.
- **Windows y `gspawn`.** El helper depende del subsistema
  (`tools/windows-portable.sh:86-95`): el host de consola usa
  `gspawn-win64-helper-console.exe`, el gráfico el otro. Copiar los dos.
- **`bintana check` y `lib/check`** necesitan la metadata; no mover `check` al
  host gráfico para "simplificar".
- **El `.cmd` del zip siempre abre consola.** Es un hueco aparte; no prometer
  que el lanzador `.cmd` no la abre. El instalador usa `bintanaw.exe` directo.
- **`api.json` y `llms-full.txt` se regeneran.** `tests/api.sh` falla si están
  viejos; no editar a mano.
- **El worker de `Task`** no corre `bta_widgets_init` y evalúa solo `rad.js`; el
  split no puede romperlo ni duplicar su instalador de globals.

## Preguntas para el dueño (antes de Fase 2)

1. ¿El objetivo que más importa es arranque, no requerir GTK instalado, o un
   lenguaje headless más chico? El plan asume lo segundo con los mismos nombres.
2. ¿Se acepta que un `main` que usa una librería de widgets falle con una frase,
   en vez de saltar automáticamente al host gráfico?
3. ¿`Application.Executable` en el host gráfico responde el dispatcher o el
   binario gráfico?
4. ¿Los nombres son `bintana`/`bintanaw` en Windows y `bintana`/`bintana-gui` en
   Linux, o `bintana`/`bintanaw` en todas partes?
5. ¿Vale 4-6 semanas de un agente, o el objetivo se conforma con un
   `bintana-cli` que corra `check` y `main` sin GTK y deje el resto igual?

## Lo que no hay que hacer

- No empezar con `BTA_NO_GTK` en las ~40.000 líneas de widgets sin la prueba de
  Fase 1.
- No usar `--unresolved-symbols=ignore-all` ni delay-load como diseño final;
  son parches de plataforma.
- No cambiar el formato `.form` ni el serializador.
- No convertir `main` en un lenguaje más chico sin decirlo en `bintana-docs` y
  `bintana-llm`.
- No dejar `bintana check` dependiendo de GTK.
- No romper el worker de `Task`, `tests/api` ni el chequeo de `api.json`.

## Primer día del agente

1. Leer `AGENTS.md`, `docs/architecture.md`, `docs/agents/runtime.md`,
   `docs/agents/lifetimes.md`, `docs/agents/testing.md`.
2. Correr `./tests/run.sh` y `./tests/api.sh` para tener la línea base.
3. Hacer las medidas de Fase 0 en la máquina que haya; no abrir ventanas en la
   pantalla del usuario (`tests/try.sh` para cualquier cosa manual).
4. Confirmar la auditoría de archivos leyendo los includes de cada `.c`; escribir
   en `docs/notes/headless-runtime.md` lo que se midió y lo que se corrigió.
5. Volver con los números y la decisión de Fase 1 antes de tocar la tabla de
   clases.
