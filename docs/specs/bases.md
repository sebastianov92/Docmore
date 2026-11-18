# Bases en Docmore — especificación

Estado: borrador para decidir (2026-11-18). Última EE del plan sin hacer.

## 1. Qué es

Una *base* es una página (`pages.is_base = true`) que en vez de cuerpo tiene una tabla: propiedades tipadas (columnas), filas con celdas en JSON, y vistas (tabla, kanban) con filtros, orden y disposición. Se abre a página completa o se incrusta en otras páginas con el nodo `base` del editor. Fórmulas calculadas en servidor, tiempo real por websocket, import/export CSV.

## 2. Decisión central: portar el linaje AGPL, no reescribir

**Hallazgo.** Upstream desarrolló Bases *fuera* de `ee/` y la relicenció después:

| Rama remota | Fecha | Servidor `core/base` | Cliente `features/base` | `packages/base-formula` |
|---|---|---|---|---|
| `origin/base` | 2026-04-23 | 41 archivos | 60 | — |
| `origin/base-duck` | 2026-04-23 | 63 (incluye caché DuckDB) | 55 | — |
| **`origin/base-kan`** | **2026-05-28** (`237bbe1f`, "kanban - wip") | **53 archivos, 6.520 líneas** | **96 archivos, 14.400 líneas** | **22 archivos, sin LICENSE** |
| `main` (`89f13c3f`, 2026-06-21) | — | submódulo privado `apps/server/src/ee` | `apps/client/src/ee/base` (176 archivos, 26.800 líneas) bajo `ee/LICENSE` | con `LICENSE` Enterprise |

En `237bbe1f` el `LICENSE` de la raíz es AGPL-3.0 sin carve-out, ningún archivo de esos tres directorios menciona la licencia Enterprise y ninguno está bajo un directorio `ee/`. Es código AGPL que podemos tomar, modificar y redistribuir bajo AGPL. Lo que main tiene en `ee/base` y `packages/base-formula/LICENSE` no se toca ni se importa desde nuestro código.

**Coste comparado.** Reescribir desde cero: ~20k líneas (motor de predicados/orden/cursor, conversión de tipos, fórmulas, grid virtualizado, kanban con drag, modal de fila, editor de fórmulas, realtime). Portar: adaptar 6,5k + 14,4k líneas a main (esquema nuevo de ids, APIs de main, Mantine 9) y escribir lo que base-kan no tiene (import CSV, pulido de kanban, duplicado de páginas).

**Riesgo del port.** base-kan es "wip": el kanban está a medias y hay 23 archivos de fórmulas por detrás de main (`number.ts`, fixes). El esquema de DB de base-kan es anterior (ids uuid de propiedad, sin `pending_token`): hay que adaptar el código al esquema de main, que ya está migrado en nuestra DB.

## 3. Lo que main ya trae (no se reescribe)

- **Migración `20260529T125146-bases.ts`** aplicada: `pages.is_base`, `pages.base_schema_version`, tablas `base_properties` (PK compuesta `(page_id, id)`, `id` varchar `prp…`, `pending_type/pending_type_options/pending_token`, `schema_version`, `deleted_at`, único por `lower(trim(name))` viva), `base_rows` (uuid v7, `cells` jsonb, `position` varchar, `deleted_at`, índices parciales por página/posición/updated/created), `base_views` (`config` jsonb, `position`, borrado físico). Funciones SQL `base_cell_text/numeric/timestamptz/bool/array` y `jsonb_set_many` (null borra la clave). Tipos Kysely y entity types listos.
- **Eventos** `BASE_*` en `event.contants.ts`; **colas** `BASE_QUEUE` y `BASE_IMPORT_QUEUE` registradas con jobs `BASE_TYPE_CONVERSION`, `BASE_CELL_GC`, `BASE_FORMULA_RECOMPUTE`, `BASE_CSV_IMPORT` y sus interfaces; **notificaciones** `base.import_completed/failed`.
- **Websocket**: `ws/base-realtime.bridge.ts` (hoy hace `require('../ee/base/realtime/base-ws.service')`), gateway que enruta `base:*`, sala `base-${pageId}`, eventos de entrada `base:subscribe|unsubscribe|presence|presence:leave`; `removeBaseSubscribersWithoutAccess` ya se llama al mover páginas y revocar grupos.
- **Editor**: nodo `base` en `packages/editor-ext` (`pageId`, `pendingKey`), registrado en colaboración; DOCX lo omite; HTML/Markdown lo exportan como div vacío.
- **Página**: `PageService.create(…, trx, isBase)`, `getPageTitle(title, isBase)` → "Untitled base", `isBase` en árbol/sidebar/favoritos, `file_tasks.page_id`, `AttachmentService.uploadFile` con `pageId` opcional, ids `generateBasePropertyId()` (`prp`+9) y `generateBaseChoiceId()` (`opt`+9).
- **Feature flag** `Feature.BASES = 'bases'` (falta añadirlo a `DOCMORE_FEATURES`).
- Paginación por cursor (`executeWithCursorPagination` con `fields` custom; `Invalid cursor` → 400).

## 4. Alcance

**v1 (este encargo)**
- Servidor `apps/server/src/core/base/` completo: bases, propiedades, filas, vistas, fórmulas, conversión de tipo, GC de celdas, realtime, export CSV, resolver de páginas.
- Cliente `apps/client/src/features/base/`: vista tabla (grid virtualizado, edición de celdas, selección, teclado, drag de filas y columnas), vista kanban, modal de fila, menú de propiedades con conversión, editor de fórmulas, filtros/orden con borradores por usuario, pestañas de vistas, incrustación en el editor (slash menu "Base" y "Kanban", barra de herramientas, chips de página vacía, pegar enlace → incrustar), ruta `/base/:pageId` y página completa.
- Import CSV (servidor + modal cliente).
- Flag `bases` licenciado; auditoría; README.

**v2 (después, si hace falta)**
- Duplicar página copia la base y remapea los embeds; restaurar de papelera limpia suscriptores.
- Vista calendario (main solo la declara en el tipo; no existe UI).
- Bases en páginas compartidas/públicas (hoy ni upstream lo soporta: el embed pide `/bases/info` autenticado y muestra "sin acceso").
- Índice de filas en búsqueda/Typesense; tools MCP `list_base_rows`/`create_base_row`.

**Fuera**: caché DuckDB (`base-duck`), relaciones/rollups entre bases, comentarios por fila, formularios, zona horaria por base (ramas posteriores de upstream), presencia (el cliente no la emite).

## 5. Modelo de datos (esquema de main; el código portado se adapta)

- **Propiedad** `{id: 'prp…', pageId, name, type, position, typeOptions, pendingType?, pendingTypeOptions?, pendingToken?, isPrimary, schemaVersion, workspaceId, …}`. Tipos: `text, longText, number, select, status, multiSelect, date, person, file, page, checkbox, url, email, createdAt, lastEditedAt, lastEditedBy, formula`. La primaria es texto, no se borra ni cambia de tipo. Nombres únicos sin distinguir mayúsculas (las fórmulas resuelven por nombre). `base-kan` no tiene `longText`: se añade (kind TEXT, límite 25.000).
- **typeOptions** por tipo: select/status/multiSelect `{choices[{id:'opt…', name, color, category?}], choiceOrder, disableColors?, defaultValue?}`; number `{format: plain|currency|percent|progress, separators, precision, currencyCode, currencySymbol, defaultValue}`; date `{dateFormat?, timeFormat: 12h|24h, includeTime?, defaultValue}`; text `{richText?, defaultValue}`; checkbox/url/email `{defaultValue}`; person `{allowMultiple?, defaultValue}`; formula `{source, ast, resultType, dependencies, astVersion: 1, formatOptions?}`.
- **Fila** `{id uuid v7, pageId, cells: {[propertyId]: valor}, position, creatorId, lastUpdatedById, …}`. Valores: text/url/email/longText string o null; number número; select/status id de opción; multiSelect `string[]`; date ISO; person id o `string[]`; file `[{id, fileName, mimeType?, fileSize?, url?}]`; page id de página; checkbox bool; formula valor o `{__err, msg, v:1}`. `createdAt/lastEditedAt/lastEditedBy` no se guardan en `cells`: salen de las columnas de la fila.
- **Vista** `{id, pageId, name, type: table|kanban, position, config}`; `config = {sorts, filter, visiblePropertyIds, hiddenPropertyIds, propertyWidths, propertyOrder, groupByPropertyId, hiddenChoiceIds, choiceOrder}` con parche semántico (clave `null` borra, ausente no toca). En los esquemas zod de base-kan `propertyId` es `z.uuid()`: pasa a `z.string().regex(/^prp[a-z0-9]{9}$/)`; los ids de opción (`opt…` o `__no_value`) son string.
- **Orden**: claves fraccionarias de `fractional-indexing-jittered`, comparadas como texto (`COLLATE "C"`). Orden de columnas por vista (`propertyOrder`), no por `property.position`.
- **Versión de esquema**: `pages.base_schema_version` sube cuando una conversión de tipo o un GC de celdas commitea; el cliente la compara en `base:subscribed` y refetchea.

## 6. API (contrato nuestro: base-kan + mejoras de main)

Todo `POST /api/...`, envoltorio `{data}` normal, `JwtAuthGuard`, scopes API key / OAuth `read|write`.

| Ruta | Cuerpo | Respuesta | Permiso |
|---|---|---|---|
| `bases/create` | `{parentPageId, template?: 'kanban'}` (inline desde el editor) o `{spaceId, name?, parentPageId?, template?}` | `IBase` | crear página en el espacio |
| `bases/convert` | `{pageId, template?}` | `IBase` (`id, slugId, spaceId`) | editar página; la página debe estar vacía |
| `bases/info` | `{pageId}` | `IBase` = página + `properties` + `views` + `permissions {canEdit, hasRestriction}` + `baseSchemaVersion` | ver página |
| `bases/update` | `{pageId, name?, icon?}` | `IBase` | editar |
| `bases/export-csv` | `{pageId, filter?}` | CSV crudo (`Content-Disposition` con `filename*=`), auditado | ver + `validateCanExport` |
| `bases/import-csv` | multipart `pageId`, `spec` (JSON), `file` (JSONL) | `IFileTask` | editar |
| `bases/pages/expand` | `{pageIds}` | `{items: ResolvedPage[]}` solo accesibles | — |
| `bases/properties/create` | `{pageId, name, type, typeOptions?, position?, requestId?}` | `IBaseProperty` | editar |
| `bases/properties/update` | `{pageId, propertyId, name?, type?, typeOptions?, clearMode?, requestId?}` | `{property, jobId: string\|null}` (cambio de tipo con datos → job y `pendingType`) | editar |
| `bases/properties/delete` | `{pageId, propertyId}` | — (no primaria; fórmulas dependientes quedan en error; encola GC) | editar |
| `bases/properties/reorder` | `{pageId, propertyId, position}` | — | editar |
| `bases/rows` | `{pageId, cursor?, limit≤100, filter?, sorts?}` | `IPagination<IBaseRow> & {references: {users, pages}}` | ver |
| `bases/rows/create` | `{pageId, cells?, afterRowId?, position?, requestId?}` | `IBaseRow` (fórmulas calculadas) | editar |
| `bases/rows/info` | `{pageId, rowId}` | `IBaseRow` | ver |
| `bases/rows/update` | `{pageId, rowId, cells (parche, null borra), position?, requestId?}` | `IBaseRow` completa con fórmulas recalculadas | editar |
| `bases/rows/delete` · `delete-many` · `reorder` | `{pageId, rowId}` · `{pageId, rowIds≤500}` · `{pageId, rowId, position}` | — | editar |
| `bases/views` · `views/create` · `views/update` · `views/delete` | `{pageId}` · `{pageId, name, type?, config?}` · `{pageId, viewId, name?, config? (parche), position?}` · `{pageId, viewId}` (no la última) | `IBaseView[]` / `IBaseView` | ver / editar |

- `requestId` (uuid v7) se devuelve en el evento websocket para que el emisor lo descarte.
- Filtros: árbol `{op: and|or, children}` de condiciones `{propertyId, op, value?}` con operadores `eq neq gt gte lt lte contains ncontains startsWith endsWith isEmpty isNotEmpty before after onOrBefore onOrAfter any none all isWithin`; valores de fecha `{mode: exact|relative|range, …}`; números y booleanos llegan como string. El motor de base-kan (`engine/predicate.ts`, 12,9 KB) ya compila esto a SQL sobre `base_cell_*`; falta `isWithin` y el modo `relative/range` de main.
- Orden con keyset en el orden pedido (cursor opaco); sin `sorts` el cliente ordena por `position`.
- Persona: usuarios del workspace vía `/search/suggest {includeUsers}`; página: páginas del espacio vía `/search/suggest {includePages, spaceId}`; archivo: `/files/upload` con el `pageId` de la base.

## 7. Tiempo real

Servicio `BaseWsService` en `core/base/realtime/` con el contrato que espera el bridge (`setServer, isBaseEvent, handleInbound, handleDisconnect, removeUsersFromSpaceBases, removeSubscribersWithoutAccess`); el bridge pasa a importarlo directo (sin `require` de `ee`). Suscripción con comprobación de acceso y respuesta `base:subscribed {schemaVersion}`. Eventos salientes (todos con `operation, pageId, requestId?`): `base:row:created {row}`, `base:row:updated {rowId, updatedCells}` (incluye fórmulas), `base:row:deleted`, `base:rows:deleted`, `base:row:reordered`, `base:rows:updated {rowIds, propertyIds}`, `base:property:created|updated|deleted|reordered`, `base:view:created|updated|deleted`, `base:schema:bumped {schemaVersion}`, `base:formula:recompute:started|completed`, `base:import:progress|completed`. Multi-instancia: por Redis como el resto del gateway (base-kan ya trae `base-ws-consumers`).

## 8. Fórmulas

- Paquete AGPL nuevo `packages/base-formula-core` (nombre npm `@docmore/base-formula`), copiado de `origin/base-kan:packages/base-formula` y actualizado por nosotros (formato de números, fixes); exports `./server` (con `evaluate`) y `./client`. El paquete EE de main queda intacto y sin uso desde nuestro código.
- Cliente: parsea, resuelve nombres → ids, tipa y detecta ciclos; manda `typeOptions` completo. Servidor: **revalida** (parse + resolve + typecheck + ciclo con `BaseFormulaGraph`), guarda, **evalúa y persiste** el valor en `cells` (así se filtra y se exporta).
- Recalculo: al actualizar una fila, solo las fórmulas afectadas (`affectedFormulas`), en `evalOrder`; al crear/cambiar una fórmula o borrar una dependencia, job `BASE_FORMULA_RECOMPUTE` por lotes de 500 con eventos de progreso. Lock por base (`formula-lock`) para no solapar.
- Límites del paquete: fuente 10k, profundidad 256/512/64. Errores en celda `{__err: MISSING_PROP|TYPE_MISMATCH|DIV_BY_ZERO|DATE_INVALID|DEPTH_EXCEEDED|DEPENDENCY_ERROR}`.

## 9. Trabajos en cola (`BASE_QUEUE`, `BASE_IMPORT_QUEUE`)

- **Conversión de tipo** (`BASE_TYPE_CONVERSION`): `update` marca `pendingType/pendingTypeOptions/pendingToken` y devuelve `jobId`; el job convierte celdas por lotes según la tabla de `conversion-warning.ts` (select→text nombre, multi→text unido por comas, multi→select primera, person→text nombre, page→text título, a number/date/url/email lo no parseable se limpia, a checkbox yes/true/1), commitea tipo nuevo, limpia pending, sube `base_schema_version`, emite `base:schema:bumped`. Si el token ya no coincide (otra edición), aborta.
- **GC de celdas** (`BASE_CELL_GC`): tras borrar una propiedad, quita la clave de todas las filas por lotes y sube la versión.
- **Import CSV** (`BASE_CSV_IMPORT`): file task tipo import, origen `csv`, `page_id` de la base. JSONL (una fila = array en el orden de `spec.columns`), `spec = {fileName, rowCount, columns: [{propertyId} | {name, type, typeOptions?}], skippedValues}`; crea propiedades nuevas, resuelve opciones por nombre (crea las que falten, colores cíclicos), personas por email/nombre, inserta por lotes de 500 con `position` creciente, progreso por websocket cada lote, al final `base:import:completed` + notificación `base.import_completed/failed` y `metadata {importedRows, skippedValues}` en la file task. Límites: 100k filas, 200 columnas, 500 opciones.

## 10. Permisos, flag, auditoría

- Un solo bit: `canEdit` de la página (`PageAccessService.validateCanViewWithPermissions`) gobierna esquema, filas y vistas; lectura = `validateCanView`. Crear base = `validateCanCreate(spaceId)`. Export = `validateCanExport`. Espacio al que no pertenece el usuario → 404. Sin CASL propio (upstream lo quitó: va por `Page`).
- `DOCMORE_FEATURES += Feature.BASES`. Sin el flag el servidor rechaza escrituras (403) y el cliente muestra solo lectura.
- `AuditEvent`: `base.created`, `base.converted`, `base.property.created|updated|deleted`, `base.view.created|updated|deleted`, `base.rows.deleted`, `base.exported`, `base.imported`. Filas individuales no se auditan (ruido).
- Borrado: la base es una página; papelera y restauración normales; borrado físico cascada por FK. `removeSubscribersWithoutAccess` al mover/borrar.

## 11. Cliente

- Portar `origin/base-kan:apps/client/src/features/base` (+ `pages/base/base-page.tsx`, `features/editor/components/base-embed/base-embed-view.tsx`, `styles/base-embed.css`) a `apps/client/src/features/base/`. Adaptar: ids `prp…`/`opt…` generados en cliente, `references` de filas en un store por base (usuarios y páginas), `requestId` en mutaciones de fila, borradores de filtro/orden por usuario en localStorage (`docmore:base-view-draft:v1:{userId}:{pageId}:{viewId}`) con "Guardar para todos", vistas: pestañas, crear tabla/kanban, borrar salvo la última; modal de fila con `?row=&rowBase=`.
- Repuntar lo que hoy importa de `@/ee/base`: `features/editor/components/base-embed/base-embed-view.tsx` y `base-paste-menu.tsx`, `empty-page/empty-page-get-started.tsx`, `slash-menu/command-list.tsx` y `menu-items.ts`, `fixed-toolbar/groups/more-inserts-group.tsx`, `pages/page/page.tsx` (render `BaseView` si `isBase`), ruta `/base/:pageId` en `App.tsx`, `trash-page-content-modal`.
- Reglas de la casa: filas y tarjetas enteras tocables; desplegables propios, nada nativo; sin emojis; probar a ~1440 px con datos reales (import CSV de 1k filas).
- Import CSV: modal propio (dropzone, parseo en cliente con PapaParse ya presente o parser propio, mapeo columna → propiedad existente/nueva con tipo detectado, vista previa, indicador de progreso).

## 12. Fases y verificación

| Fase | Entregable | Prueba |
|---|---|---|
| F0 | Extraer los tres directorios de `237bbe1f` a `scratch/`, auditoría de licencia (grep), diff de fórmulas base-kan↔main para portar fixes, paquete `@docmore/base-formula` compilando | `pnpm -F @docmore/base-formula build` + tests del paquete (6 specs de base-kan) |
| F1 | Servidor núcleo: módulo, repos, engine (predicate/sort/cursor/search) con ids varchar, controladores de bases/propiedades/filas/vistas, create inline/convert/info/expand, realtime, flag, auditoría | batería `scratchpad/bases-cases.sh` (CRUD, filtros por tipo, orden+cursor, permisos, requestId, eventos ws con un cliente socket.io en Node) |
| F2 | Fórmulas + jobs: formula.service, recompute, conversión de tipo con pending token, GC, schema version | batería ampliada + specs jest de engine y fórmulas |
| F3 | Cliente: port + repunte de montajes + embed + página completa + kanban terminado | navegador: crear desde slash menu, editar celdas, filtros/orden/borradores, kanban drag, modal de fila, fórmula, conversión de tipo, dos pestañas en tiempo real |
| F4 | Export e import CSV (servidor + modal) | export con filtro, import 1k filas con tipos mixtos, progreso, errores |
| F5 | README, memoria, commit por fase y push al final | `pnpm tsc` server + client, baterías anteriores (MCP, IA) siguen verdes |

Orden de commits: uno por fase, push al terminar F5 (como las etapas anteriores). Docker rebuild por fase (~5 min).

## 13. Decisiones que te pido

1. **Portar el linaje AGPL de `origin/base-kan`** (recomendado) o reescribir desde cero.
2. Nombre del paquete de fórmulas: `@docmore/base-formula` nuevo (recomendado) o sustituir el contenido del paquete EE de main.
3. Import CSV en v1 (F4, recomendado) o dejarlo para después.
4. Compartir bases en páginas públicas: fuera de v1 (recomendado).
5. Caché DuckDB de `base-duck`: no (recomendado; Postgres con índices parciales basta para el homelab).
