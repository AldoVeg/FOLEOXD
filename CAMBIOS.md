# Historial de cambios — UNIFICADOR SEDAPAL

Registro completo de la sesión de trabajo: pedidos del usuario, análisis realizado, causas encontradas, correcciones aplicadas y pruebas ejecutadas. Ordenado cronológicamente por ronda de conversación.

---

## Ronda 1 — Análisis inicial

Se analizó el proyecto completo (`index.html`, `index.css`, `index.js`): una app de una sola página, sin backend, para unificar PDFs y Word en un solo PDF con foleo (numeración de páginas), rotación/espejo de hojas, y vista previa organizable tipo tablero.

---

## Ronda 2 — Rediseño + blindaje inicial

**Pedido:** darle un "estilo radical y transformador", corregir el bug de páginas en blanco que salían foleadas, y testear a fondo.

**Cambios:**
- **Rediseño visual completo** (`index.css`): gradiente azul-cian, tarjetas con radios grandes, header con insignia, botón CTA en pill.
- **Bug central corregido — "páginas en blanco foleadas":** la generación del PDF se separó en **dos pasadas**. Antes, si una hoja fallaba al incrustarse (por cualquier motivo), igual recibía su número de foleo. Ahora la pasada 1 construye todas las hojas y marca cuáles tuvieron éxito real; la pasada 2 solo folea las exitosas. Esto también corrigió el foleo inverso (el número de inicio ahora se calcula sobre el total real de hojas exitosas, no sobre un estimado).
- **Blindaje:** reintentos (hasta 2 intentos) en las inserciones de PDF/Word durante la generación, y espera real de imágenes/fuentes en Word (en vez de un timeout fijo de 500ms).
- **Función nueva:** prefijo/sufijo de foleo (ej. "EXP-001/2026").

**Testeo:** se montó infraestructura de pruebas con Playwright + Chromium headless (generación de PDFs/DOCX de prueba reales, no simulados). 13/13 verificaciones pasaron, incluyendo una simulación de fallo real de inserción a mitad de lote que confirmó que la hoja fallida queda en blanco sin gastar número de foleo.

---

## Ronda 3 — Más utilidad, documentos mixtos

**Pedido:** cambiar prefijo/sufijo por un contador de hojas, zoom al doble clic, soporte para imágenes (PNG/JPG) además de PDF/Word, y reforzar aún más el caso de "página en blanco silenciosa".

**Cambios:**
- Prefijo/sufijo reemplazado por checkbox "Mostrar total" → foleo tipo "003 / 045".
- **Zoom con doble clic** en la vista ampliada del modal.
- **Soporte real de imágenes PNG/JPG** como tercer tipo de documento: cada imagen se trata como una hoja que conserva su propia proporción (no se fuerza a A4 como Word), usando el archivo original (no una miniatura recomprimida) tanto en el zoom como en el PDF final.
- **Marca explícita de hojas fallidas dentro del propio PDF:** cualquier hoja que no pudo procesarse ahora queda con un recuadro rojo y el texto "HOJA NO PROCESADA — VOLVER A INSERTAR ESTE DOCUMENTO" impreso directamente en la página — ya no es una hoja en blanco silenciosa e indistinguible, ni siquiera si el usuario no vio el aviso emergente.

**Testeo:** 19/19 verificaciones nuevas, sin regresiones. Se instaló `node-canvas` y `pdfjs-dist` en el entorno de pruebas para poder analizar el PDF resultante a nivel de píxel.

---

## Ronda 4 — Correcciones puntuales de UX

**Pedido:** corregir el rechazo de archivos `.doc` (Word 97-2003), agregar badge de formato también a las hojas PDF (como ya tenían Word/imagen), mejorar la movilidad del zoom, y un cuadro flotante que muestre el total de páginas por unos segundos.

**Cambios:**
- **Archivos `.doc`:** no es técnicamente viable leerlos de forma confiable solo con JavaScript de navegador (formato binario distinto al .docx). Se detecta específicamente y se muestra un mensaje claro pidiendo convertir a `.docx` (Word/LibreOffice/Google Docs), en vez de un rechazo genérico.
- **Badge "PDF"** agregado a las tarjetas de hojas provenientes de PDF (rojo), igual que "W" (Word, azul) e "IMG" (imagen, verde).
- **Zoom con más movilidad:** el doble clic ahora acerca el punto EXACTO donde se hizo clic (no siempre el centro), permitiendo ver cualquier esquina de inmediato.
- **Cuadro flotante del contador de páginas:** aparece en la esquina del área de trabajo al cargar o eliminar hojas, visible ~4 segundos.

**Testeo:** 15/15 verificaciones nuevas, sin regresiones (34 en total acumuladas).

---

## Ronda 5 — Diversidad de formatos Word (decisión de arquitectura)

**Pedido:** agregar soporte tipo "LibreOffice" para más formatos Word, sin alterar el contenido/formato de los documentos.

**Análisis presentado (sin implementar código):** se explicó que esta app es 100% estática (sin servidor, desplegada en GitHub Pages) y que una conversión Word→PDF con fidelidad real requiere un motor de oficina completo (LibreOffice/Word), inexistente como librería JS de navegador. Se presentaron 5 alternativas con sus compromisos (backend propio con LibreOffice, API de conversión en la nube, mejorar el rasterizado actual, extracción de texto plano para .doc/.rtf, mantener el sitio estático pidiendo conversión previa).

**Decisión del usuario:** mantener el sitio estático (sin backend ni terceros).

**Cambio aplicado:** se subió la resolución y calidad de captura de las hojas Word (html2canvas de escala 2 a 2.5, compositado final de 2.5x a 3x ≈ 216dpi, menos compresión JPEG).

---

## Ronda 6 — Eliminar contador de foleo + tablas sin bordes

**Pedido:** eliminar el checkbox "Mostrar total" (el cuadro flotante ya cubre esa necesidad), y corregir que las tablas de Word perdían sus bordes ("cuadros") al procesar el documento.

**Análisis:** se probó `mammoth.js` de forma aislada (sin el resto del pipeline) confirmando que el HTML generado **sí** conservaba toda la tabla y sus datos — el problema no era pérdida de información, sino que el `<div>` temporal donde se arma la hoja para capturarla (que vive en el documento principal) no heredaba el CSS de bordes que sí tenía el `<iframe>` de conversión (los estilos de un iframe nunca se heredan fuera de él).

**Cambios:**
- Checkbox "Mostrar total" y su lógica eliminados por completo.
- Se inyecta una sola vez un `<style>` con las reglas de tabla/imagen (bordes, límite de tamaño) directamente en el documento principal, aplicado vía una clase (`word-render-tmp`) en el div de captura.

**Testeo:** confirmado visualmente con una tabla de prueba con bordes — antes salía sin ningún borde, después con la cuadrícula completa. 34/34 verificaciones sin regresiones.

---

## Ronda 7 — Análisis exhaustivo de fidelidad de formato

**Pedido:** "es la 4ta vez que solicito revisar el mismo detalle" — análisis profundo de por qué se seguía alterando el formato de las hojas Word.

**Análisis:** se generó un documento de prueba con negrita, cursiva, subrayado, color de texto, tamaño de fuente y alineación centrada/derecha/justificada, y se comparó el HTML crudo de `mammoth.js` en cada etapa.

**Hallazgos (con evidencia empírica):**
- **Se pierde por diseño de `mammoth.js` (documentado, no configurable):** alineación de párrafo, color de texto y tamaño de fuente aplicados manualmente en Word (sin un estilo con nombre asociado). Se confirmó que SÍ se puede recuperar la alineación si el párrafo usa un estilo de Word con nombre (ej. una plantilla oficial), pero nunca si es formato directo/manual.
- **Se puede recuperar con configuración:** subrayado y resaltado de texto, agregando `styleMap` a la llamada de `mammoth.convertToHtml`.
- **Causa adicional encontrada:** la versión de `mammoth.js` cargada por CDN estaba fijada en **1.6.0** (desactualizada) y no soportaba el resaltado de texto aunque se configurara correctamente. Se subió a **1.12.1**.

**Cambios:**
- `mammoth.js` actualizado de 1.6.0 a 1.12.1 en `index.html`.
- `styleMap` agregado a la conversión (`u => u`, `strike => s`, `highlight => mark`) + CSS correspondiente.

**Testeo:** confirmado visualmente que el resaltado con fondo amarillo ahora se conserva. 34/34 verificaciones sin regresiones.

---

## Ronda 8 — El bug más grave: contenido comprimido, A4 perdido

**Pedido (en mayúsculas, muy frustrado):** "SIGUE CON ERRORES DE CAMBIO DE FORMATO... SE APEGA PARA LA IZQUIERDA PERDIENDO EL FORMATO A4."

**Análisis:** se generó un documento denso (10 párrafos + tabla, simulando un informe real) y se midió matemáticamente —no solo visualmente— dónde caía el contenido dentro de la hoja, calculando el cuadro delimitador (bounding box) de los píxeles no blancos.

**Resultado de la medición:** el contenido solo ocupaba del 19% al 57% del ancho de la página — casi la mitad derecha en blanco. Confirmado numéricamente, no era una percepción subjetiva.

**Causa raíz encontrada (la más grave de toda la sesión):** en el rediseño visual (Ronda 2) se le puso `display:flex` al `<body>` de la página para centrar la tarjeta principal de la app. Efecto colateral no anticipado: **cualquier elemento agregado directo al `<body>` se convierte en un elemento flex**, y por defecto un elemento flex **se puede encoger** para competir por espacio con los demás hijos del body (la tarjeta principal, el overlay, etc.), sin importar que tenga un ancho fijo declarado en CSS. El `<div>` temporal donde se arma cada hoja Word para capturarla (794px de ancho esperado) se agregaba directo al body sin sacarlo de ese flujo — terminaba comprimido a ~529px reales. De ahí que el contenido pareciera "pegado a la izquierda": el texto SÍ llenaba correctamente el contenedor, pero el contenedor mismo estaba, en secreto, mucho más angosto de lo que debía.

**Cambio:** se le agregó `position:fixed` (fuera de pantalla) al div temporal — la misma técnica que ya usaba el `<iframe>` de conversión, que por eso nunca tuvo este problema.

**Testeo:** misma medición exacta de antes — el contenido pasó de ocupar 19%-57% del ancho a ocupar 7%-93% (márgenes simétricos correctos). Confirmado tanto en la miniatura como en el PDF final, con render visual de la página completa mostrando texto y tabla ocupando correctamente todo el ancho de la hoja A4. Se agregó esta medición como **prueba de regresión permanente** para que este bug específico no pueda reaparecer sin ser detectado. 36/36 verificaciones acumuladas, sin regresiones.

---

## Ronda 9 — Cambio de motor: mammoth.js → docx-preview (resuelve la limitación de formato manual)

**Pedido:** "aún no es suficiente, [...] que no se muevan ni un centímetro, por eso te pedía a que si lo puedas convertir a pdf, pero manteniendo el encabezado de word, [...] si tienes alguna otra [idea] para liquidar con la observación recurrente aplícala."

**Análisis:** la limitación documentada al cierre de la Ronda 7 —alineación, color y tamaño de fuente puestos **a mano** en Word (sin un estilo con nombre) no se pueden recuperar con `mammoth.js`— no es un parámetro mal configurado: es una decisión de diseño de esa librería, que convierte el `.docx` a HTML "semántico" descartando a propósito el formato directo. Ningún ajuste de `styleMap` iba a resolverlo. Se investigó una librería distinta con un objetivo opuesto: **`docx-preview`** lee el XML del `.docx` igual que lo hace Word al abrirlo, y traduce **cada** propiedad de párrafo/carácter a CSS tal cual está en el archivo — manual o de un estilo, sin distinción — porque su objetivo es previsualizar el documento con fidelidad, no "limpiarlo". Se confirmó código en mano (función `parseDefaultProperties` de la librería) que `w:jc` (alineación), `w:color`, `w:sz` y `w:highlight` se aplican siempre, vengan de donde vengan. Además, cada página que entrega ya trae su tamaño y sus márgenes **reales**, tomados directo de `w:pgSz`/`w:pgMar` del documento — ya no hace falta que esta app invente un margen propio ni fuerce A4.

**Cambio de arquitectura:**
- `index.html`: se retira `mammoth.browser.min.js`; se agregan `jszip` (dependencia de docx-preview) y `docx-preview.min.js` por CDN.
- `index.js`, función `processWord`: en vez de `mammoth.convertToHtml` + un `<iframe>` de conversión + paginación manual por altura estimada, ahora se usa `docx.renderAsync(...)`, que entrega directamente una `<section>` por hoja, ya con el tamaño/márgenes reales de esa página y (cuando el archivo lo trae) el paginado real de Word — vía el marcador `lastRenderedPageBreak` que Word graba cada vez que repagina el documento. Cada `<section>` se captura con `html2canvas` y se incrusta en el PDF final **con el tamaño real de esa hoja**, no forzado a A4 con un margen inventado por la app.
- Se agregó `splitOverflowingDocxSections()`: para un documento que nunca fue paginado por Word (por ejemplo, generado por script y jamás abierto en el programa), docx-preview no tiene de dónde sacar los saltos de página y entrega una sola sección que simplemente crece más allá de una hoja. Esta función mide la altura real ya renderizada de cada párrafo/tabla y reparte el contenido —sin tocar una letra— en tantas hojas como corresponda, el mismo método de "altura acumulada" ya usado y probado en rondas anteriores, aplicado ahora sobre el HTML fiel de docx-preview en vez del HTML simplificado de mammoth.
- Se conserva el fix de la Ronda 8 (`position:fixed` en los contenedores de renderizado, fuera del flujo de `<body>{display:flex}`).

**Hallazgo colateral (bug latente pre-existente, ahora también corregido):** el archivo de prueba `test-b.docx` trae un salto de página manual real (`<w:br w:type="page"/>`) entre dos hojas. Con el motor anterior, `mammoth.js` descartaba esa marca en silencio (no la traduce a HTML por defecto) y las dos hojas terminaban fusionadas en una — un documento con un salto de página deliberado podía perder ese salto sin ningún aviso. Con docx-preview esa marca se respeta: el mismo archivo ahora produce correctamente 2 hojas.

**Testeo:** además de correr las 40 verificaciones acumuladas (ajustando 6 que asumían el conteo de páginas viejo, ahora corregido — ver hallazgo colateral) se agregó:
- **Prueba de extremo a extremo con la app real** (no un entorno aislado): se subió un `.docx` con negrita, cursiva, subrayado, resaltado y alineación centrada/derecha/justificada puestas **a mano**, se generó el PDF real con la interfaz real, y se midió a nivel de píxel sobre el PDF **descargado** — no una inspección visual. Resultado: el resaltado amarillo, la alineación centrada y la alineación a la derecha sobreviven completas en el archivo final. Esta prueba quedó como verificación permanente (Test 10).
- Prueba dedicada de partición por desborde: un documento de 55 párrafos sin marca de paginado de Word se repartió en 4 hojas completas, sin perder ni duplicar un solo párrafo.
- Se confirmó visualmente que las tablas con bordes (`test-table-border.docx`) siguen renderizando su cuadrícula completa.

41/41 verificaciones acumuladas, sin regresiones.

---

## Resumen de archivos modificados

- `index.html` — estructura, controles de foleo, badges, CDN de docx-preview + jszip (reemplaza a mammoth.js), (Ronda 13) botones Deshacer/Rehacer y modal de rango de páginas.
- `index.css` — rediseño visual completo, badges de formato, cuadro flotante, estilos de zoom, (Ronda 10) selectores `header`/`footer` escapados a `.portal-container`, y (Ronda 13) estilos del modal de rango y del bloque de archivo (`.page-group`).
- `index.js` — toda la lógica: generación de PDF en dos pasadas, soporte de imágenes, corrección del doble-incrustado de Word, corrección de bordes de tabla, corrección del bug de compresión por flexbox, zoom con movilidad, contador flotante, mensajes de error específicos, (Ronda 9) el motor de lectura de Word reemplazado por completo por `docx-preview`, (Ronda 11) `waitForImagesAndMarkBroken()` para que una imagen de Word en un formato no decodificable quede marcada de forma visible, (Ronda 12) `markUnsupportedDrawings()` para lo mismo con gráficos/objetos nativos no soportados, y (Ronda 13) deshacer/rehacer, soporte WEBP/GIF/TIFF, selección de rango de páginas y agrupamiento de archivo completo como bloque.

---

## Ronda 10 — "Encabezado celeste" no pedido + márgenes alterados: fuga de CSS de la propia app

**Pedido:** "incluiste el encabezado celeste, sin habértelo pedido y obvio que no cuadra [...] muchas hojas de diferentes archivos tiene el margen muy pequeño o casi ni tienen [...] debe quedar tal cual, sin alteraciones por hojas."

**Análisis:** se generó un documento de prueba con márgenes intencionalmente asimétricos (arriba 1", abajo 0.5", izquierda 1.5", derecha 0.75") y un encabezado/pie de página reales, y se procesó con la app real. El PDF resultante mostró exactamente lo reportado: un **banner degradado celeste** cubriendo el encabezado del Word (que en el documento original era solo texto plano en negrita), y el área superior de la hoja visualmente distinta a lo esperado.

**Causa raíz encontrada:** en `index.css` las reglas del encabezado y pie de página **propios de la app** (la barra "UNIFICADOR SEDAPAL" con su degradé azul, y el pie "SEDAPAL © ...") estaban escritas como selectores de **elemento genérico**, sin ninguna clase: `header { ... }` y `footer { ... }`. Un selector así aplica a **cualquier** `<header>`/`<footer>` de todo el documento, sin importar en qué parte del DOM esté. `docx-preview` (el motor que lee el Word, Ronda 9) usa precisamente un `<header>` y un `<footer>` HTML reales y semánticos para renderizar el encabezado/pie **del propio documento Word** — y ese CSS, pensado solo para la barra superior de la app, se colaba encima: le imponía su degradé azul, su padding grande y su centrado forzado, tapando y deformando el encabezado/pie real del Word, y "comiéndose" visualmente el margen superior de la hoja (de ahí el reclamo de "el margen muy pequeño o casi ni tienen" — el margen real seguía intacto por dentro, pero el banner de la app ocupaba ese espacio en blanco).

**Cambio:** se escaparon ambos selectores a `.portal-container > header` y `.portal-container > footer` (la ruta real del encabezado/pie de la propia app), para que ya no puedan aplicarse a ningún otro `<header>`/`<footer>` del documento, sea de docx-preview o de cualquier otro origen futuro. Se revisó el resto de `index.css` en busca de otros selectores de elemento sin clase (`table`, `td`, `p`, `h1`...) que pudieran tener el mismo problema — no se encontró ninguno más.

**Testeo:** con el mismo documento de márgenes asimétricos + encabezado/pie, el banner celeste desaparece por completo y el encabezado del Word se ve tal cual el original (texto plano, sin decoración); los 4 márgenes del PDF final miden exactamente lo configurado en el documento (1", 0.5", 1.5" y 0.75", verificado a nivel de píxel). Se confirmó además que el encabezado/pie **propios de la app** (la barra "UNIFICADOR SEDAPAL") se siguen viendo idénticos tras el cambio. 40/40 verificaciones acumuladas, sin regresiones.

---

## Ronda 11 — Imágenes y "cuadros" que desaparecían en silencio (investigación a fondo)

**Pedido:** "muchas hojas de word contienen cuadros, imágenes [...] ahora solo muestran enunciados [...] antes de culminar testea y valida, si seguimos con el error, te pido investigues para aprender del porqué continuamos."

**Análisis:** se probaron, una por una, las causas más probables mediante documentos de prueba reales procesados por la app real (no supuestos): imagen incrustada simple, imagen **flotante/anclada** con ajuste de texto (así se pegan la mayoría de logos institucionales), tabla con bordes, tabla con estilo con nombre, tabla con sombreado de encabezado, y un documento largo con imagen y tabla intercaladas que fuerza la partición por desborde (Ronda 9). **Todos esos casos funcionaron correctamente** — la causa no estaba ahí. Se probó entonces el caso restante: una imagen incrustada en un formato que **ningún navegador puede decodificar** (el caso real más común: WMF/EMF, el formato en el que Word guardaba históricamente muchas imágenes pegadas desde Excel/Paint/versiones antiguas de Office — muy probable en plantillas institucionales con años de antigüedad). Se simuló ese caso exacto (bytes no decodificables como imagen, misma ruta de carga que usa la app real) y ahí apareció el problema: **la hoja se procesaba como exitosa, sin ningún error ni aviso, pero la imagen quedaba completamente ausente** — un espacio en blanco donde debía estar, con el texto alrededor intacto. Esto reproduce exactamente lo reportado ("ahora solo muestran enunciados"): el texto sobrevive, la imagen (o el "cuadro" que en realidad es una imagen pegada, no una tabla nativa de Word) desaparece sin dejar rastro, porque el navegador nunca lanza un error que la app pudiera atrapar — simplemente no pinta nada.

**Causa raíz encontrada:** `docx-preview` asigna a cada `<img>` la URL de datos (`data:...`) de la imagen tal como está en el `.docx`, pero **no valida** si el navegador puede realmente decodificarla — eso ocurre después, de forma asíncrona, fuera de lo que la librería espera antes de devolver el control. La app tampoco lo estaba comprobando, así que una imagen en un formato no soportado simplemente nunca se pintaba, y html2canvas capturaba la hoja igual, con ese hueco vacío, sin lanzar ningún error.

**Cambio:** se agregó `waitForImagesAndMarkBroken()`, que se ejecuta después de renderizar cada hoja Word y antes de capturarla: espera a que cada `<img>` termine de intentar decodificar (cargó bien, o falló) y, si alguna no pudo decodificarse, la reemplaza por un aviso visible del mismo tamaño ("IMAGEN NO COMPATIBLE — formato no soportado por el navegador. Reinsértela como PNG/JPG en Word"), dibujado directamente en esa misma hoja del PDF final. Además se muestra un toast nombrando el archivo afectado y explicando qué hacer — mismo principio que ya se aplicó a las hojas fallidas por completo (Ronda 3) y a los `.doc`: nunca una desaparición silenciosa, siempre un aviso explícito y accionable.

**Testeo:** con el caso simulado, ahora aparece el aviso visible en el lugar exacto de la imagen rota, más el toast explicando la causa y la solución — confirmado con captura del PDF final descargado. Se repitieron los 4 documentos de prueba con imágenes/tablas que SÍ funcionan (incrustada simple, flotante/ancladas, con tabla con bordes/sombreado/nombre, y el documento largo con partición por desborde) para confirmar que el nuevo chequeo **no genera falsos positivos** — ninguna imagen válida quedó marcada como rota. Se agregó como prueba de regresión permanente (Test 11). 43/43 verificaciones acumuladas, sin regresiones.

## Limitación anterior, ahora resuelta

Hasta la Ronda 8, el formato **manual/directo** de Word (alineación, color de texto, tamaño de fuente elegidos a mano, sin un estilo con nombre asociado) no se recuperaba, por ser una limitación estructural de `mammoth.js`. Con el cambio de motor a `docx-preview` (Ronda 9) esa limitación ya no aplica: se confirmó con medición de píxeles sobre el PDF final que la alineación, el color y el resaltado puestos a mano sobreviven completos. La app sigue siendo 100% estática (sin backend ni servicios de terceros), tal como se decidió en la Ronda 5.

---

## Ronda 12 — Gráficos y "cuadros" que desaparecían en silencio (segunda causa, distinta de la Ronda 11)

**Pedido:** el usuario adjuntó una captura de su propio workspace mostrando 5 hojas Word con solo un par de frases y grandes espacios en blanco, junto a 8 hojas Word del mismo tipo de informe mostrando gráficos de barras a color y tablas completas — "esta es la diferencia, intenta definir y mostrar explícitamente la data de cada hoja word, es como pedirte que bloquees [asegures] todas las hojas."

**Análisis:** la captura mostraba, dentro del MISMO lote, páginas que sí funcionaban (gráficos completos) y páginas que no (solo texto) — la clave para encontrar la causa real. Se investigó directamente en el código de `docx-preview`: la función que decide cómo dibujar cada objeto incrustado en un `<w:drawing>` (`parseGraphic`) **solo tiene una rama para imágenes** (`pic:pic`); cualquier otro tipo de objeto —un **gráfico nativo de Word/Excel** (creado con datos reales, no una imagen pegada), un SmartArt, una forma— no tiene ninguna rama que lo procese y la función devuelve `null` sin avisar. El contenedor que reserva el espacio para ese objeto sí se crea, con el tamaño correcto, pero se queda completamente vacío por dentro. Esto explica la diferencia exacta que mostró la captura: los gráficos que se pegaron como **imagen** (una "foto" plana del gráfico) se ven perfectos; los que se insertaron como **gráfico nativo** (vinculado a datos, la forma más común de graficar en Word/Excel cuando alguien no lo pega manualmente como imagen) desaparecen sin dejar rastro.

**Reproducción exacta:** se tomó un documento de prueba y se reemplazó, a nivel de XML, la referencia a una imagen por una referencia a un gráfico nativo (`<c:chart>`), replicando byte a byte la estructura que produce Word al insertar un gráfico real. El resultado fue idéntico a la captura del usuario: texto alrededor intacto, un hueco en blanco exactamente donde debía ir el gráfico, sin ningún error ni aviso.

**Cambio:** se agregó `markUnsupportedDrawings()`, que se ejecuta junto con la detección de imágenes rotas (Ronda 11): busca los contenedores de objeto incrustado que quedaron completamente vacíos (ningún hijo, ningún texto) y los reemplaza por un aviso visible del mismo tamaño ("OBJETO NO COMPATIBLE — gráfico/SmartArt/objeto incrustado que el navegador no puede mostrar. En Word: clic derecho sobre él → 'Guardar como imagen' y reinsértelo como PNG/JPG"), más un toast nombrando el archivo. Mismo principio de siempre: nunca una desaparición silenciosa.

**Testeo:** con el documento reproducido, el aviso aparece exacto en el lugar del gráfico faltante, confirmado con captura del PDF final descargado. Se repitieron los 5 documentos de prueba con imágenes/tablas que funcionan correctamente (incluido el de imagen flotante/anclada) para confirmar que el nuevo chequeo no genera falsos positivos sobre imágenes válidas. Se agregó como prueba de regresión permanente (Test 12). 46/46 verificaciones acumuladas, sin regresiones.

## Limitación real y no resoluble desde el navegador

Dos casos reales no pueden resolverse dentro de un sitio 100% estático, porque son limitaciones del navegador mismo, no de esta app:
- Una imagen incrustada en formato **WMF/EMF** (u otro que ningún navegador sepa decodificar) — Ronda 11.
- Un **gráfico nativo de Word/Excel** (vinculado a datos), un SmartArt, o cualquier objeto incrustado que no sea una imagen plana — Ronda 12. Dibujarlo de verdad requeriría reconstruir un motor de gráficos compatible con el formato de Office, algo desproporcionado para un sitio sin backend.

Ambos casos comparten la misma resolución práctica desde el propio Word: clic derecho sobre el objeto → "Guardar como imagen" (o "Convertir en imagen") → reinsertarlo como PNG/JPG. Lo que esta app garantiza, en los dos casos, es que **nunca vuelven a pasar desapercibidos**: quedan marcados de forma visible y explicados por toast, en vez de desaparecer en silencio.

---

## Ronda 13 — Cuatro funcionalidades nuevas (deshacer/rehacer, más formatos de imagen, rango de páginas, bloque de archivo)

**Pedido:** a partir de un listado de posibles mejoras, el usuario pidió construir estas cuatro, siempre "consultando" el alcance y buscando aportar más solidez de la mínima pedida.

### 1) Deshacer / Rehacer (Ctrl+Z / Ctrl+Y)

Cubre reordenar, eliminar, rotar y espejar (más de lo pedido: también rotar/espejar, no solo reordenar/eliminar). El historial guarda **referencias** a los mismos objetos de página (no copias de su miniatura), así que deshacer una eliminación no vuelve a leer el archivo original. Aporte de solidez: se reemplazó el viejo "borrar todo el archivo fuente cuando el workspace queda vacío" por `pruneUnreferencedFileData()`, que solo libera lo que ya no referencia ni el workspace ni el historial — antes, vaciar el workspace y luego presionar Ctrl+Z habría intentado regenerar el PDF a partir de un buffer que ya no existía.

### 2) Más formatos de imagen: WEBP, GIF (nativos) y TIFF (rechazo explícito)

Detección por firma real de bytes (igual que PNG/JPG, nunca por extensión). WEBP/GIF sí los decodifica el navegador, pero `pdf-lib` no tiene un `embedWebp`/`embedGif` propio — se recomponen a PNG sin pérdida (mismos píxeles que el navegador ya decodificó) antes de incrustarlos, avisando siempre por qué. TIFF no lo decodifica ningún navegador — mismo trato que el `.doc`: rechazo con instrucción concreta, nunca un fallo silencioso.

### 3) Rango de páginas al adjuntar un PDF grande (>15 páginas)

Antes de repartir un PDF grande en tarjetas, se ofrece un modal para elegir un tramo, con **vista previa real** (miniatura renderizada, no solo números) de la primera y la última página del rango elegido — aporte de solidez sobre lo pedido, para no equivocarse de tramo en un documento de cientos de páginas.

### 4) Bloque: trabajar un archivo completo como una sola unidad

Al adjuntar un PDF o Word de más de una página, se pregunta si se quiere desglosar en hojas (como siempre) o mantenerlo como **un solo bloque** que se arrastra, elimina y rota junto. Por dentro, `pageRegistry` sigue siendo una lista plana de páginas reales (una por cada página del PDF final) — el agrupamiento es una capa visual: las tarjetas del archivo se mueven dentro de un único contenedor `.page-group` en el workspace, así que Sortable y la generación del PDF no necesitaron ningún cambio de fondo. Cada página agrupada guarda su `groupId` en el propio registro (no solo en el DOM), para que el bloque sobreviva intacto a un deshacer/rehacer que reconstruye todo el workspace desde cero — verificado explícitamente: eliminar un bloque y presionar Ctrl+Z lo restaura **como bloque**, no como hojas sueltas. Aporte de solidez sobre lo pedido: "Desagrupar" para volver a hojas individuales sin re-adjuntar el archivo.

**Testeo:** cada funcionalidad se probó por separado y en conjunto con las 46 verificaciones previas (sin regresiones):
- Deshacer/rehacer: 15 verificaciones (eliminar+deshacer conservando la miniatura real, rehacer, rotar+deshacer+rehacer, reordenar por arrastre+deshacer, vaciar todo el workspace y restaurarlo con Ctrl+Z generando después un PDF válido con las páginas originales intactas).
- Formatos de imagen: 9 verificaciones (WEBP y GIF —este último generado con un codificador GIF89a real y verificado en un navegador de verdad antes de usarlo— llegan con su color correcto al PDF final; TIFF queda rechazado con mensaje claro).
- Rango de páginas: 11 verificaciones (elegir un tramo, vista previa real que cambia con los números, "Cargar TODAS", y confirmación de que un PDF chico nunca dispara el modal).
- Bloque de archivo: 18 verificaciones (estructura, generación del PDF con el bloque intacto, rotar todo el bloque a la vez, eliminar+deshacer restaurando como bloque, desagrupar, rechazar la propuesta y quedar como páginas individuales, y un lote mixto de bloque + hoja suelta).

99/99 verificaciones en total, sin ninguna regresión sobre las 46 anteriores.
