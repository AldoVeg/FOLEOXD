/* ═══════════════════════════════════════════════════
   index.js — UNIFICADOR SEDAPAL (Fortificado v8)
   ✅ Multi-Drag manual de grupo
   ✅ Documentos mixtos: PDF + Word/DOCX + imágenes PNG/JPG
   ✅ Foleo normal + inverso, SIEMPRE arriba-derecha, con
      total opcional ("003 / 045")
   ✅ Rotación (90°) + Espejo (horizontal/vertical) combinables
   ✅ Zoom con doble clic + arrastre en la vista ampliada
   ✅ Alcance de transformación: esta hoja / seleccionadas / todas
   ✅ Nombre de archivo personalizado
   ✅ Paginación Word real (ya no genera hojas en blanco)
   ✅ Generación en 2 pasadas: una hoja en blanco por fallo de
      inserción NUNCA gasta ni recibe número de foleo, y además
      queda marcada de forma explícita DENTRO del PDF final —
      "hoja en blanco silenciosa" es un caso que ya no existe
   ✅ Reintentos en inserciones PDF/Word/imagen + espera real de
      imágenes/fuentes en Word (menos hojas en blanco por timing)
   ✅ Límite de memoria/páginas · Guardas de CDN reforzadas
   ✅ IIFE estricto · Magic bytes
   ═══════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ── Guard DOM ── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {

    /* ── Validación CDNs esenciales ── */
    if (typeof pdfjsLib === 'undefined') {
      const banner = document.getElementById('cdn-error');
      if (banner) { banner.classList.remove('hidden'); banner.textContent = '⚠️ Motor PDF no disponible. Verifica tu conexión.'; }
      return;
    }
    if (typeof Sortable === 'undefined') {
      console.warn('⚠️ SortableJS no disponible. Solo drag nativo.');
    }
    const HTML2CANVAS_OK  = typeof html2canvas !== 'undefined';
    const DOCXPREVIEW_OK  = typeof docx !== 'undefined' && typeof JSZip !== 'undefined';

    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

    /* ── Límites de memoria / seguridad de ejecución (Fix #7) ── */
    const MAX_TOTAL_PAGES  = 400;                 // páginas totales permitidas en el workspace
    const MAX_TOTAL_BYTES  = 200 * 1024 * 1024;   // 200MB de archivos cargados por lote

    /* ── Referencias DOM ── */
    const workspace       = document.getElementById('workspace');
    const btnGenerate      = document.getElementById('btn-generate');
    const overlay           = document.getElementById('loading-overlay');
    const textStatus       = document.getElementById('loading-text');
    const progressBar      = document.getElementById('progress-bar');
    const dropZone           = document.getElementById('drop-zone');
    const fileInput           = document.getElementById('file-input');
    const chkFoleo             = document.getElementById('chk-foleo');
    const chkFoleoInv         = document.getElementById('chk-foleo-inverso');
    const folioStart           = document.getElementById('folio-start');
    const outputFilenameInput = document.getElementById('output-filename');

    /* ── Estado interno ── */
    let pdfDocumentsData   = new Map();
    let wordDocumentsData  = new Map();
    let imageDocumentsData = new Map(); // fileId -> { buffer, name, mimeType } (imagen ORIGINAL sin recomprimir)
    let pageRegistry      = [];
    let multiDragGroup    = null;
    let multiDragAnchor   = null;
    let autoSelectedByDrag = null;
    let dragUndoBefore    = null; // snapshot de pageRegistry capturado al iniciar un arrastre (deshacer/rehacer)
    let isGenerating      = false;
    const revokedUrls     = new Set();
    const modalState      = { currentId: null, requestToken: 0 };
    const modalZoomState  = { zoomed: false, tx: 0, ty: 0, dragging: false, startX: 0, startY: 0 };
    const MODAL_ZOOM_SCALE = 2.4;
    const modalHighResCache = new Map(); // pageId -> dataURL (solo dura la sesión del modal)
    const modalPdfDocCache  = new Map(); // fileId -> documento pdf.js ya cargado (solo dura la sesión)
    const HIGH_RES_SCALE = 2.2;
    const HIGH_RES_CACHE_CAP = 20; // últimas hojas vistas en nítido, por sesión de modal

    const generateId = () => {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
      return Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    };

    /* ═══════════════════════════════════════════════
       UTILIDADES
       ═══════════════════════════════════════════════ */
    function showToast(msg, type) {
      const container = document.getElementById('toast-container');
      if (!container) return;
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + (type || 'info');
      toast.textContent = msg;
      toast.addEventListener('click', () => {
        toast.classList.add('toast-out');
        setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
      });
      container.appendChild(toast);
      setTimeout(() => {
        if (toast.parentNode) {
          toast.classList.add('toast-out');
          setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
        }
      }, 5000);
    }

    function showLoader(msg, withProgress) {
      if (!overlay) return;
      textStatus.textContent = msg || 'Procesando...';
      overlay.classList.remove('hidden');
      progressBar.classList.toggle('hidden', !withProgress);
      if (withProgress) progressBar.value = 0;
    }

    function updateProgress(cur, total) {
      if (!progressBar || progressBar.classList.contains('hidden')) return;
      progressBar.value = Math.round((cur / total) * 100);
    }

    function hideLoader() {
      if (!overlay) return;
      overlay.classList.add('hidden');
      progressBar.classList.add('hidden');
    }

    function isValidPDF(buffer) {
      const arr = new Uint8Array(buffer.slice(0, 5));
      return arr[0] === 0x25 && arr[1] === 0x50 && arr[2] === 0x44 && arr[3] === 0x46; // %PDF
    }

    function isValidDOCX(buffer) {
      const arr = new Uint8Array(buffer.slice(0, 2));
      return arr[0] === 0x50 && arr[1] === 0x4B; // PK (zip)
    }

    /* Reintenta una operación async hasta `attempts` veces (blindaje ante
       fallos puntuales de inserción/incrustación durante la generación del
       PDF final — Fix: "páginas en blanco foleadas"). Si `fn` lanza a mitad
       de camino, nunca deja contenido a medio dibujar: cada intento crea
       sus propios objetos temporales desde cero. */
    async function retryAsync(fn, attempts, delayMs) {
      let lastErr;
      for (let a = 0; a < attempts; a++) {
        try {
          return await fn();
        } catch (e) {
          lastErr = e;
          if (a < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
        }
      }
      throw lastErr;
    }

    /* Detecta el formato real de imagen por firma de bytes (nunca por
       extensión/MIME, que el usuario o el sistema operativo pueden
       reportar mal). PNG/JPG se incrustan tal cual (pdf-lib los soporta
       de forma nativa); WEBP/GIF el navegador los decodifica sin problema
       pero pdf-lib NO tiene un embedWebp/embedGif propio, así que se
       recomponen a PNG sin pérdida antes de incrustarlos (ver
       processImage) — se avisa de esto explícitamente, nunca en silencio.
       TIFF no se puede decodificar en NINGÚN navegador, así que se
       detecta para rechazarlo con un mensaje claro (mismo trato que
       ".doc"), en vez de fallar sin explicación. */
    function detectImageType(buffer) {
      const arr = new Uint8Array(buffer.slice(0, 12));
      if (arr[0] === 0x89 && arr[1] === 0x50 && arr[2] === 0x4E && arr[3] === 0x47) return 'png';
      if (arr[0] === 0xFF && arr[1] === 0xD8 && arr[2] === 0xFF) return 'jpeg';
      // WEBP: "RIFF"...."WEBP"
      if (arr[0] === 0x52 && arr[1] === 0x49 && arr[2] === 0x46 && arr[3] === 0x46 &&
          arr[8] === 0x57 && arr[9] === 0x45 && arr[10] === 0x42 && arr[11] === 0x50) return 'webp';
      // GIF: "GIF87a" o "GIF89a"
      if (arr[0] === 0x47 && arr[1] === 0x49 && arr[2] === 0x46 && arr[3] === 0x38 &&
          (arr[4] === 0x37 || arr[4] === 0x39) && arr[5] === 0x61) return 'gif';
      // TIFF: "II*\0" (little-endian) o "MM\0*" (big-endian)
      if ((arr[0] === 0x49 && arr[1] === 0x49 && arr[2] === 0x2A && arr[3] === 0x00) ||
          (arr[0] === 0x4D && arr[1] === 0x4D && arr[2] === 0x00 && arr[3] === 0x2A)) return 'tiff';
      return null;
    }

    /* Convierte un ArrayBuffer a base64 en trozos (evita el límite de
       argumentos de String.fromCharCode al pasarle un buffer grande de una
       sola vez, algo real con fotos de varios MB). */
    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    }

    function loadImageElement(src) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('No se pudo decodificar la imagen'));
        img.src = src;
      });
    }


    /* Normaliza el nombre de archivo elegido por el usuario (Requerimiento #1) */
    function resolveOutputFilename() {
      let raw = (outputFilenameInput && outputFilenameInput.value || '').trim();
      if (!raw) {
        raw = 'SEDAPAL_Unificado_' + new Date().toISOString().split('T')[0];
      }
      raw = raw.replace(/\.pdf$/i, '');              // evita doble ".pdf.pdf"
      raw = raw.replace(/[\\/:*?"<>|]/g, '_');       // caracteres no válidos en nombres de archivo
      raw = raw.slice(0, 150);
      return raw + '.pdf';
    }

    /* ═══════════════════════════════════════════════
       SYNC REGISTRY ↔ DOM
       ═══════════════════════════════════════════════ */
    function syncRegistryWithDOM() {
      const newOrder = [];
      Array.from(workspace.children).forEach(el => {
        if (el.classList.contains('page-group')) {
          // Un bloque es UN solo hijo directo del workspace, pero
          // representa varias hojas reales — se listan en el orden interno
          // que ya tienen dentro de la franja del bloque (pageRegistry
          // sigue siendo una lista plana, una entrada por hoja real; el
          // agrupamiento es puramente una capa visual/de arrastre).
          Array.from(el.querySelectorAll('.page-card')).forEach(card => {
            const record = pageRegistry.find(p => p.id === card.dataset.id);
            if (record) newOrder.push(record);
          });
          return;
        }
        const record = pageRegistry.find(p => p.id === el.dataset.id);
        if (record) newOrder.push(record);
      });
      pageRegistry = newOrder;
      btnGenerate.disabled = (pageRegistry.length === 0) || isGenerating;
    }

    /* ═══════════════════════════════════════════════
       DESHACER / REHACER (Ctrl+Z / Ctrl+Y)
       Cubre reordenar, eliminar, rotar y espejar — cualquier acción que
       cambie el orden de pageRegistry o el rotation/mirrorH/mirrorV de una
       hoja. Cada entrada del historial guarda REFERENCIAS a los mismos
       objetos de pageRegistry (no copias de sus datos pesados como el
       thumb), así que deshacer una eliminación no necesita volver a leer
       el archivo original — el objeto de esa hoja nunca se destruyó,
       solo se sacó del array. ═══════════════════════════════════════════════ */
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    let undoStack = [];
    let redoStack = [];
    const UNDO_CAP = 30;

    function snapshotRegistry() {
      return pageRegistry.map(r => ({ ref: r, rotation: r.rotation, mirrorH: r.mirrorH, mirrorV: r.mirrorV }));
    }

    function signatureOf(snapshot) {
      return snapshot.map(e => e.ref.id + ':' + e.rotation + ':' + (e.mirrorH ? 1 : 0) + ':' + (e.mirrorV ? 1 : 0)).join('|');
    }

    function updateUndoRedoUI() {
      if (btnUndo) btnUndo.disabled = undoStack.length === 0;
      if (btnRedo) btnRedo.disabled = redoStack.length === 0;
    }

    /* Envuelve cualquier acción que mute pageRegistry (reordenar, eliminar,
       rotar, espejar): guarda el estado ANTES de ejecutarla y, si algo
       realmente cambió, lo agrega al historial. Si la acción termina sin
       cambiar nada (ej. "Forzar Vertical" sobre hojas que ya estaban
       verticales), no se ensucia el historial con un paso inútil. */
    function withUndo(mutatorFn) {
      const before = snapshotRegistry();
      mutatorFn();
      const after = snapshotRegistry();
      if (signatureOf(before) !== signatureOf(after)) {
        undoStack.push(before);
        if (undoStack.length > UNDO_CAP) undoStack.shift();
        redoStack = [];
        updateUndoRedoUI();
      }
    }

    /* Libera del mapa de datos fuente cualquier archivo que ya no esté
       referenciado ni por el workspace actual ni por el historial de
       deshacer/rehacer — reemplaza al viejo "limpiar todo cuando el
       workspace queda vacío", que hubiera borrado el buffer original de
       una hoja que el usuario todavía podía traer de vuelta con Ctrl+Z. */
    function pruneUnreferencedFileData() {
      const live = new Set();
      pageRegistry.forEach(r => live.add(r.fileId));
      undoStack.forEach(snap => snap.forEach(e => live.add(e.ref.fileId)));
      redoStack.forEach(snap => snap.forEach(e => live.add(e.ref.fileId)));
      [pdfDocumentsData, wordDocumentsData, imageDocumentsData].forEach(map => {
        Array.from(map.keys()).forEach(key => { if (!live.has(key)) map.delete(key); });
      });
    }

    function rebuildWorkspaceFromRegistry() {
      workspace.innerHTML = '';
      let i = 0;
      while (i < pageRegistry.length) {
        const r = pageRegistry[i];
        if (r.isFailed) {
          createFailedCardDOM(r);
          i++;
          continue;
        }
        if (r.groupId) {
          // Reconstruye el bloque completo a partir de la RACHA de
          // registros consecutivos con el mismo groupId — el agrupamiento
          // se guarda como dato en cada registro (no solo en el DOM), para
          // que sobreviva a un deshacer/rehacer que reconstruye todo el
          // workspace desde cero.
          const gid = r.groupId;
          const runRecords = [];
          while (i < pageRegistry.length && pageRegistry[i].groupId === gid) {
            runRecords.push(pageRegistry[i]);
            i++;
          }
          const memberCardEls = runRecords.map(rec => {
            createCardInDOM(rec);
            renderCardTransform(rec.id);
            return document.querySelector('[data-id="' + rec.id + '"]');
          });
          workspace.appendChild(buildGroupWrapperDOM(gid, runRecords[0].groupFileName, memberCardEls));
          continue;
        }
        createCardInDOM(r);
        renderCardTransform(r.id);
        i++;
      }
      syncRegistryWithDOM();
      updateSelectionUI();
    }

    function restoreSnapshot(snapshot) {
      pageRegistry = snapshot.map(e => {
        e.ref.rotation = e.rotation;
        e.ref.mirrorH = e.mirrorH;
        e.ref.mirrorV = e.mirrorV;
        return e.ref;
      });
      rebuildWorkspaceFromRegistry();
      pruneUnreferencedFileData();
      if (modalState.currentId && !pageRegistry.find(p => p.id === modalState.currentId)) closeModal();
    }

    function undo() {
      if (undoStack.length === 0) return;
      redoStack.push(snapshotRegistry());
      if (redoStack.length > UNDO_CAP) redoStack.shift();
      restoreSnapshot(undoStack.pop());
      updateUndoRedoUI();
      showToast('↶ Acción deshecha (Ctrl+Y para rehacer)', 'success');
    }

    function redo() {
      if (redoStack.length === 0) return;
      undoStack.push(snapshotRegistry());
      if (undoStack.length > UNDO_CAP) undoStack.shift();
      restoreSnapshot(redoStack.pop());
      updateUndoRedoUI();
      showToast('↷ Acción rehecha', 'success');
    }

    if (btnUndo) btnUndo.addEventListener('click', undo);
    if (btnRedo) btnRedo.addEventListener('click', redo);

    /* Cierra el registro de deshacer para un arrastre de Sortable: el
       "antes" se capturó en onStart (dragUndoBefore); aquí se compara
       contra el estado ya sincronizado tras soltar la hoja. Separado de
       withUndo() porque el arrastre abarca dos callbacks distintos
       (onStart/onEnd), no una sola función que se pueda envolver. */
    function finishDragUndo() {
      if (!dragUndoBefore) return;
      const after = snapshotRegistry();
      if (signatureOf(dragUndoBefore) !== signatureOf(after)) {
        undoStack.push(dragUndoBefore);
        if (undoStack.length > UNDO_CAP) undoStack.shift();
        redoStack = [];
        updateUndoRedoUI();
      }
      dragUndoBefore = null;
    }

    /* ═══════════════════════════════════════════════
       SORTABLE — MULTI-DRAG MANUAL
       ═══════════════════════════════════════════════ */
    if (typeof Sortable !== 'undefined') {
      new Sortable(workspace, {
        animation: 150,
        ghostClass: 'sortable-ghost',
        chosenClass: 'sortable-chosen',
        dragClass: 'sortable-drag',
        delay: 0,
        delayOnTouchOnly: true,
        touchStartThreshold: 3,
        // Evita iniciar un arrastre cuando el usuario hace clic en las
        // herramientas de rotación/espejo o en el botón de eliminar.
        filter: '.card-tool, .btn-delete-page, .btn-ungroup',
        preventOnFilter: true,

        onStart(evt) {
          // Estado justo antes de que Sortable mueva nada — comparado en
          // onEnd contra el resultado final para decidir si este arrastre
          // entra al historial de deshacer (Ctrl+Z).
          dragUndoBefore = snapshotRegistry();

          // Un bloque (.page-group) se arrastra como una sola unidad — la
          // lógica de multi-selección de abajo es solo para tarjetas
          // sueltas (.page-card) y no aplica aquí.
          if (evt.item.classList.contains('page-group')) {
            autoSelectedByDrag = null;
            multiDragGroup = null;
            multiDragAnchor = null;
            return;
          }

          const card = evt.item;
          const selected = document.querySelectorAll('.page-card.selected');

          if (!card.classList.contains('selected')) {
            document.querySelectorAll('.page-card.selected').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            // Marca que ESTA selección fue solo un efecto secundario del
            // arrastre (para reordenar), no una selección deliberada del
            // usuario — así en onEnd se revierte y no deja flechas abiertas
            // "pegadas" después de cada vez que reordenas una hoja.
            autoSelectedByDrag = card.dataset.id;
            multiDragGroup = null;
            multiDragAnchor = null;
            return;
          }

          autoSelectedByDrag = null;

          if (selected.length <= 1) {
            multiDragGroup = null;
            multiDragAnchor = null;
            return;
          }

          multiDragGroup = [];
          multiDragAnchor = card.dataset.id;

          selected.forEach(c => {
            if (c !== card) {
              multiDragGroup.push({ element: c, id: c.dataset.id });
              c.style.display = 'none';
            }
          });

          let badge = card.querySelector('.multi-drag-badge');
          if (!badge) {
            badge = document.createElement('span');
            badge.className = 'multi-drag-badge';
            card.appendChild(badge);
          }
          badge.textContent = '+' + multiDragGroup.length;
        },

        onEnd() {
          // Revierte la "selección" que fue solo efecto colateral del
          // arrastre — así el reordenamiento normal no deja las flechas
          // de esa hoja abiertas después de soltarla.
          if (autoSelectedByDrag) {
            const draggedCard = document.querySelector('[data-id="' + autoSelectedByDrag + '"]');
            if (draggedCard) draggedCard.classList.remove('selected');
            autoSelectedByDrag = null;
          }

          if (!multiDragGroup || multiDragGroup.length === 0) {
            const badge = document.querySelector('.multi-drag-badge');
            if (badge) badge.remove();
            syncRegistryWithDOM();
            updateSelectionUI();
            finishDragUndo();
            return;
          }

          const anchorCard = document.querySelector('[data-id="' + multiDragAnchor + '"]');
          if (anchorCard) {
            multiDragGroup.forEach(item => {
              item.element.style.display = '';
              anchorCard.parentNode.insertBefore(item.element, anchorCard.nextSibling);
            });
          } else {
            multiDragGroup.forEach(item => {
              item.element.style.display = '';
              workspace.appendChild(item.element);
            });
          }

          const badge = document.querySelector('.multi-drag-badge');
          if (badge) badge.remove();

          multiDragGroup = null;
          multiDragAnchor = null;
          syncRegistryWithDOM();
          updateSelectionUI();
          finishDragUndo();
        }
      });
    }

    /* ═══════════════════════════════════════════════
       ROTACIÓN / ESPEJO — Requerimiento #2
       ═══════════════════════════════════════════════ */

    function getTransformScope() {
      const selectedCount = document.querySelectorAll('.page-card.selected').length;
      if (chkTodas && chkTodas.checked) return 'all';
      return selectedCount > 1 ? 'selected' : 'this';
    }

    function resolveTargetIds(clickedId) {
      const scope = getTransformScope();
      if (scope === 'all') {
        return pageRegistry.filter(p => !p.isFailed).map(p => p.id);
      }
      if (scope === 'selected') {
        const ids = Array.from(document.querySelectorAll('.page-card.selected'))
          .map(c => c.dataset.id);
        return ids.length > 0 ? ids : [clickedId];
      }
      return [clickedId];
    }

    /* ═══════════════════════════════════════════════
       BARRA FLOTANTE DE SELECCIÓN
       Solo visible con selección activa o "Todas" marcado;
       desaparece del todo en cualquier otro caso.
       ═══════════════════════════════════════════════ */
    const selectionBar       = document.getElementById('selection-bar');
    const selectionCount     = document.getElementById('selection-count');
    const chkTodas           = document.getElementById('chk-todas');
    const btnForceVertical   = document.getElementById('btn-force-vertical');
    const btnForceHorizontal = document.getElementById('btn-force-horizontal');
    const pageCountBadge     = document.getElementById('page-count-badge');
    let pageCountBadgeTimer  = null;

    /* Cuadro flotante con el total de páginas — Requerimiento: mostrarlo
       "por lo menos 3-5 segundos" cada vez que cambia (al cargar Y al
       eliminar hojas, no solo al cargar). */
    function flashPageCountBadge() {
      if (!pageCountBadge) return;
      const count = pageRegistry.filter(p => !p.isFailed).length;
      if (count === 0) {
        pageCountBadge.classList.remove('show');
        return;
      }
      pageCountBadge.textContent = count === 1 ? '1 página en total' : count + ' páginas en total';
      pageCountBadge.classList.add('show');
      if (pageCountBadgeTimer) clearTimeout(pageCountBadgeTimer);
      pageCountBadgeTimer = setTimeout(() => {
        pageCountBadge.classList.remove('show');
      }, 4000);
    }

    function updateSelectionUI() {
      const count = document.querySelectorAll('.page-card.selected').length;
      const todasOn = chkTodas && chkTodas.checked;

      // Las flechas de una hoja NO seleccionada quedan en opacity:0 (CSS),
      // pero sin esto seguirían siendo alcanzables con Tab aunque invisibles
      // — un usuario navegando por teclado "aterrizaría" en un botón que no
      // puede ver. Se sacan del orden de tabulación mientras no se muestren.
      document.querySelectorAll('.page-card').forEach(card => {
        const isSel = card.classList.contains('selected');
        card.querySelectorAll('.card-tool').forEach(btn => {
          btn.tabIndex = isSel ? 0 : -1;
        });
      });

      if (!selectionBar) return;
      const visible = count >= 1 || todasOn;
      selectionBar.classList.toggle('hidden', !visible);
      if (selectionCount) {
        selectionCount.textContent = todasOn
          ? 'Todas las hojas'
          : (count === 1 ? '1 hoja seleccionada' : count + ' hojas seleccionadas');
      }
    }

    if (chkTodas) chkTodas.addEventListener('change', updateSelectionUI);

    /* ── FORZAR VERTICAL / HORIZONTAL (Fix: acción absoluta e idempotente,
       no daña hojas que ya están en la orientación deseada — a diferencia
       de "rotar", que siempre suma 90° sin importar el estado actual) ── */
    function effectiveOrientation(record) {
      const swapped = (record.rotation === 90 || record.rotation === 270);
      const base = record.baseOrientation || 'vertical';
      if (!swapped) return base;
      return base === 'vertical' ? 'horizontal' : 'vertical';
    }

    function forceOrientation(desired, explicitIds) {
      let idsToUse;
      if (explicitIds) {
        // Llamada desde el modal: el alcance ya viene resuelto por quien llama.
        idsToUse = explicitIds;
      } else {
        const todasOn = chkTodas && chkTodas.checked;
        idsToUse = todasOn
          ? pageRegistry.filter(p => !p.isFailed).map(p => p.id)
          : Array.from(document.querySelectorAll('.page-card.selected')).map(c => c.dataset.id);
      }

      if (idsToUse.length === 0) {
        showToast('Selecciona al menos una hoja, o marca "Todas".', 'warning');
        return;
      }

      let changedCount = 0;
      withUndo(() => {
        idsToUse.forEach(id => {
          const record = pageRegistry.find(p => p.id === id);
          if (!record || record.isFailed) return;
          const current = effectiveOrientation(record);
          if (current === desired) return; // ya está bien, no se toca (idempotente)
          record.rotation = (record.rotation + 90) % 360;
          changedCount++;
          renderCardTransform(id);
        });
      });

      if (modalState.currentId) renderModalTransform();

      showToast(
        changedCount > 0
          ? changedCount + ' hoja(s) ajustada(s) a ' + (desired === 'vertical' ? 'vertical' : 'horizontal') + '.'
          : 'Ya estaban todas en esa orientación.',
        'success'
      );
    }

    if (btnForceVertical) btnForceVertical.addEventListener('click', () => forceOrientation('vertical'));
    if (btnForceHorizontal) btnForceHorizontal.addEventListener('click', () => forceOrientation('horizontal'));

    /* Aplica la transformación visual (CSS) + la guarda en el registro de datos.
       `explicitIds`: si se pasa (usado por el modal), ignora resolveTargetIds
       y aplica exactamente a esos ids — así el modal decide su propio alcance
       (una sola hoja o "todas") sin depender del estado de selección de la
       grilla principal. */
    function applyTransform(clickedId, action, explicitIds) {
      const targetIds = explicitIds || resolveTargetIds(clickedId);

      withUndo(() => {
        targetIds.forEach(id => {
          const record = pageRegistry.find(p => p.id === id);
          if (!record || record.isFailed) return;

          record.rotation = record.rotation || 0;
          record.mirrorH  = !!record.mirrorH;
          record.mirrorV  = !!record.mirrorV;

          switch (action) {
            case 'rotate-cw':
              record.rotation = (record.rotation + 90) % 360;
              break;
            case 'rotate-ccw':
              record.rotation = (record.rotation + 270) % 360;
              break;
            case 'mirror-h':
              record.mirrorH = !record.mirrorH;
              break;
            case 'mirror-v':
              record.mirrorV = !record.mirrorV;
              break;
          }

          renderCardTransform(id);
        });
      });

      // Si el modal está abierto y la hoja visible fue afectada, refresca su vista.
      if (modalState.currentId && targetIds.includes(modalState.currentId)) {
        renderModalTransform();
      }
    }

    /* Refleja rotation/mirrorH/mirrorV en el <img> de la tarjeta (vista previa) */
    function renderCardTransform(id) {
      const record = pageRegistry.find(p => p.id === id);
      if (!record) return;
      const card = document.querySelector('[data-id="' + id + '"]');
      if (!card) return;
      const img = card.querySelector('.page-image');
      if (!img) return;

      const sx = record.mirrorH ? -1 : 1;
      const sy = record.mirrorV ? -1 : 1;
      img.style.transform = 'rotate(' + (record.rotation || 0) + 'deg) scale(' + sx + ',' + sy + ')';

      // Indicador discreto de que la hoja tiene transformación activa
      let indicator = card.querySelector('.transform-indicator');
      const hasTransform = (record.rotation && record.rotation !== 0) || record.mirrorH || record.mirrorV;
      if (hasTransform) {
        if (!indicator) {
          indicator = document.createElement('span');
          indicator.className = 'transform-indicator';
          card.appendChild(indicator);
        }
        const parts = [];
        if (record.rotation) parts.push(record.rotation + '°');
        if (record.mirrorH) parts.push('⇋');
        if (record.mirrorV) parts.push('⇵');
        indicator.textContent = parts.join(' ');
      } else if (indicator) {
        indicator.remove();
      }
    }

    function buildCardToolsHTML() {
      return (
        '<div class="card-tools" role="group" aria-label="Rotar y espejar página">' +
          '<button type="button" class="card-tool" data-action="rotate-ccw" title="Rotar 90° a la izquierda" aria-label="Rotar 90° a la izquierda">' +
            '<svg viewBox="0 0 24 24"><path d="M4 9a8 8 0 1 1 1.5 8.5M4 9V4M4 9h5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
          '<button type="button" class="card-tool" data-action="rotate-cw" title="Rotar 90° a la derecha" aria-label="Rotar 90° a la derecha">' +
            '<svg viewBox="0 0 24 24"><path d="M20 9a8 8 0 1 0-1.5 8.5M20 9V4M20 9h-5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
          '<button type="button" class="card-tool" data-action="mirror-h" title="Espejo horizontal" aria-label="Espejo horizontal">' +
            '<svg viewBox="0 0 24 24"><path d="M12 3v18M6 8l-3 4 3 4M18 8l3 4-3 4" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
          '<button type="button" class="card-tool" data-action="mirror-v" title="Espejo vertical" aria-label="Espejo vertical">' +
            '<svg viewBox="0 0 24 24"><path d="M3 12h18M8 6l4-3 4 3M8 18l4 3 4-3" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
        '</div>'
      );
    }

    /* ═══════════════════════════════════════════════
       MODAL: VISTA AMPLIADA (doble clic en una tarjeta)
       ═══════════════════════════════════════════════ */
    const modalEl        = document.getElementById('page-modal');
    const modalImage     = document.getElementById('modal-image');
    const modalImageWrap = document.getElementById('modal-image-wrap');
    const modalLoader    = document.getElementById('modal-loader');
    const modalPageCount = document.getElementById('modal-page-count');
    const modalPrevBtn   = document.getElementById('modal-prev');
    const modalNextBtn   = document.getElementById('modal-next');
    const modalCloseBtn  = document.getElementById('modal-close');
    const modalBackdrop  = document.getElementById('modal-backdrop');
    const modalToolsEl   = document.getElementById('modal-tools');
    const modalApplyAll  = document.getElementById('modal-apply-all');

    function getNavigablePages() {
      return pageRegistry.filter(p => !p.isFailed);
    }

    function openModal(id) {
      const record = pageRegistry.find(p => p.id === id);
      if (!record || record.isFailed || !modalEl) return;
      modalState.currentId = id;
      // El checkbox "Aplicar a todas" siempre arranca desmarcado al abrir,
      // para que nunca herede un estado invisible de una apertura anterior.
      if (modalApplyAll) modalApplyAll.checked = false;
      modalEl.classList.remove('hidden');
      renderModalTransform();
      document.addEventListener('keydown', handleModalKeydown);
    }

    async function closeModal() {
      if (!modalEl) return;
      modalEl.classList.add('hidden');
      modalState.currentId = null;
      document.removeEventListener('keydown', handleModalKeydown);

      // Libera la caché de alta resolución y los documentos pdf.js abiertos
      // para esta sesión del modal — no deben quedar viviendo en memoria
      // indefinidamente después de cerrar.
      modalHighResCache.clear();
      for (const doc of modalPdfDocCache.values()) {
        try { await doc.destroy(); } catch (e) { /* silencioso */ }
      }
      modalPdfDocCache.clear();
    }

    function handleModalKeydown(e) {
      if (e.key === 'Escape') closeModal();
      if (e.key === 'ArrowLeft') navigateModal(-1);
      if (e.key === 'ArrowRight') navigateModal(1);
    }

    function navigateModal(dir) {
      const ids = getNavigablePages().map(p => p.id);
      const idx = ids.indexOf(modalState.currentId);
      if (idx === -1) return;
      const newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= ids.length) return; // ya está en un extremo
      modalState.currentId = ids[newIdx];
      renderModalTransform();
    }

    /* Genera (o reutiliza de la caché de esta sesión) una versión en alta
       resolución de la página. Las páginas de Word ya se generaron a buena
       resolución desde su origen, así que se usa su miniatura tal cual. */
    async function getHighResImage(record) {
      if (record.isWord) return record.thumb;
      if (modalHighResCache.has(record.id)) return modalHighResCache.get(record.id);

      if (record.isImage) {
        // A diferencia de la miniatura (recomprimida y achicada para la
        // tarjeta), aquí se sirve el archivo ORIGINAL tal como se subió —
        // el zoom debe mostrar el detalle real, no una versión degradada.
        const entry = imageDocumentsData.get(record.fileId);
        const dataUrl = entry
          ? 'data:' + entry.mimeType + ';base64,' + arrayBufferToBase64(entry.buffer)
          : record.thumb;
        modalHighResCache.set(record.id, dataUrl);
        if (modalHighResCache.size > HIGH_RES_CACHE_CAP) {
          const oldestKey = modalHighResCache.keys().next().value;
          modalHighResCache.delete(oldestKey);
        }
        return dataUrl;
      }

      let pdfDoc = modalPdfDocCache.get(record.fileId);
      if (!pdfDoc) {
        const entry = pdfDocumentsData.get(record.fileId);
        if (!entry) return record.thumb; // no debería pasar, pero no se rompe la vista
        // .slice(0) clona el buffer: pdf.js puede "consumir" el ArrayBuffer
        // original, y ese mismo buffer podría necesitarse después para
        // generar el PDF final — nunca se le pasa la referencia directa.
        pdfDoc = await pdfjsLib.getDocument({ data: entry.buffer.slice(0) }).promise;
        modalPdfDocCache.set(record.fileId, pdfDoc);
      }

      const page = await pdfDoc.getPage(record.pageIndex + 1);
      const viewport = page.getViewport({ scale: HIGH_RES_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      canvas.width = 0;

      modalHighResCache.set(record.id, dataUrl);
      // Tope de la caché (probado con simulación: siempre descarta lo más
      // antiguo primero) — así navegar muchas hojas dentro de una misma
      // sesión del modal no acumula memoria sin límite.
      if (modalHighResCache.size > HIGH_RES_CACHE_CAP) {
        const oldestKey = modalHighResCache.keys().next().value;
        modalHighResCache.delete(oldestKey);
      }
      return dataUrl;
    }

    /* Zoom con doble clic — Requerimiento: "opción de zoom al doble click".
       Compone rotación/espejo (ya existentes) con un escalado + desplazamiento
       de zoom. El translate va PRIMERO (en píxeles de pantalla) para que el
       arrastre se sienta natural sin importar cómo esté rotada la hoja. */
    function applyModalImageTransform(record) {
      if (!modalImage || !record) return;
      const sx = record.mirrorH ? -1 : 1;
      const sy = record.mirrorV ? -1 : 1;
      const rot = record.rotation || 0;
      const zoomScale = modalZoomState.zoomed ? MODAL_ZOOM_SCALE : 1;

      modalImage.style.transform =
        'translate(' + modalZoomState.tx + 'px,' + modalZoomState.ty + 'px) ' +
        'scale(' + zoomScale + ') ' +
        'rotate(' + rot + 'deg) scale(' + sx + ',' + sy + ')';

      modalImage.classList.toggle('zoomable', !modalZoomState.zoomed);
      modalImage.classList.toggle('zoomed', modalZoomState.zoomed);
    }

    function resetModalZoom() {
      modalZoomState.zoomed = false;
      modalZoomState.tx = 0;
      modalZoomState.ty = 0;
      modalZoomState.dragging = false;
    }

    function currentModalRecord() {
      return pageRegistry.find(p => p.id === modalState.currentId);
    }

    // Límite razonable de arrastre: no deja que la imagen se vaya tan lejos
    // que el usuario "pierda" la hoja fuera del marco visible.
    function clampModalPan() {
      if (!modalImageWrap) return;
      const rect = modalImageWrap.getBoundingClientRect();
      const maxX = (rect.width * (MODAL_ZOOM_SCALE - 1)) / 2;
      const maxY = (rect.height * (MODAL_ZOOM_SCALE - 1)) / 2;
      modalZoomState.tx = Math.max(-maxX, Math.min(maxX, modalZoomState.tx));
      modalZoomState.ty = Math.max(-maxY, Math.min(maxY, modalZoomState.ty));
    }

    if (modalImage) {
      // Zoom hacia el PUNTO donde se hizo doble clic (no siempre al centro):
      // así se puede acercar cualquier esquina o borde de la hoja de
      // inmediato, sin depender de que el usuario descubra que además se
      // puede arrastrar para reencuadrar — Fix: "solo se enfoca en un lado
      // sin poder mover y observar otras partes".
      modalImage.addEventListener('dblclick', (e) => {
        e.preventDefault();
        if (!modalZoomState.zoomed && modalImageWrap) {
          const rect = modalImageWrap.getBoundingClientRect();
          const localX = ((e.clientX - rect.left) / rect.width - 0.5) * rect.width;
          const localY = ((e.clientY - rect.top) / rect.height - 0.5) * rect.height;
          modalZoomState.tx = -localX * MODAL_ZOOM_SCALE;
          modalZoomState.ty = -localY * MODAL_ZOOM_SCALE;
          modalZoomState.zoomed = true;
          clampModalPan();
        } else {
          modalZoomState.zoomed = false;
          modalZoomState.tx = 0;
          modalZoomState.ty = 0;
        }
        applyModalImageTransform(currentModalRecord());
      });

      modalImage.addEventListener('pointerdown', (e) => {
        if (!modalZoomState.zoomed) return;
        modalZoomState.dragging = true;
        modalZoomState.startX = e.clientX - modalZoomState.tx;
        modalZoomState.startY = e.clientY - modalZoomState.ty;
        modalImage.classList.add('dragging');
        modalImage.setPointerCapture(e.pointerId);
      });

      modalImage.addEventListener('pointermove', (e) => {
        if (!modalZoomState.dragging) return;
        modalZoomState.tx = e.clientX - modalZoomState.startX;
        modalZoomState.ty = e.clientY - modalZoomState.startY;
        clampModalPan();
        applyModalImageTransform(currentModalRecord());
      });

      const endDrag = () => {
        modalZoomState.dragging = false;
        modalImage.classList.remove('dragging');
      };
      modalImage.addEventListener('pointerup', endDrag);
      modalImage.addEventListener('pointercancel', endDrag);
    }

    // Desplazamiento con rueda del mouse / gesto de dos dedos en trackpad,
    // mientras está en zoom — Fix: "se hace difícil poder movilizarse
    // mediante el documento ya ampliado". El arrastre con clic sigue
    // funcionando, pero mover el scroll/trackpad es más natural e
    // inmediato para explorar una hoja ampliada sin tener que "encontrar"
    // el gesto de arrastre.
    if (modalImageWrap) {
      modalImageWrap.addEventListener('wheel', (e) => {
        if (!modalZoomState.zoomed) return;
        e.preventDefault();
        modalZoomState.tx -= e.deltaX;
        modalZoomState.ty -= e.deltaY;
        clampModalPan();
        applyModalImageTransform(currentModalRecord());
      }, { passive: false });
    }

    async function renderModalTransform() {
      const record = pageRegistry.find(p => p.id === modalState.currentId);
      if (!record || !modalImage) return;

      // Guarda contra clics rápidos de siguiente/anterior: si el usuario
      // navega de nuevo antes de que termine este render, la respuesta
      // vieja se descarta al llegar (nunca pisa la imagen correcta actual).
      const myToken = ++modalState.requestToken;
      const targetId = record.id;

      const rot = record.rotation || 0;
      const swapDims = (rot === 90 || rot === 270);

      // El marco se ajusta de inmediato a la proporción real de la hoja
      // (considerando si está rotada), sin esperar a la imagen nítida —
      // así no hay "salto" de tamaño cuando la imagen en alta resolución
      // termine de cargar.
      if (modalImageWrap && record.nativeWidth && record.nativeHeight) {
        const w = swapDims ? record.nativeHeight : record.nativeWidth;
        const h = swapDims ? record.nativeWidth : record.nativeHeight;
        modalImageWrap.style.aspectRatio = w + ' / ' + h;
      }

      // Cada render (abrir, navegar, rotar/espejar) parte con el zoom
      // reiniciado — evita combinaciones raras de zoom heredado de una
      // hoja distinta o de un estado de rotación anterior.
      resetModalZoom();
      applyModalImageTransform(record);

      // Mientras se genera la versión nítida, se muestra la miniatura ya
      // existente (nunca una pantalla vacía) + un loader discreto encima.
      modalImage.src = record.thumb || '';
      if (modalLoader) modalLoader.classList.remove('hidden');

      const ids = getNavigablePages().map(p => p.id);
      const idx = ids.indexOf(modalState.currentId);
      if (modalPrevBtn) modalPrevBtn.disabled = (idx <= 0);
      if (modalNextBtn) modalNextBtn.disabled = (idx === -1 || idx >= ids.length - 1);
      if (modalPageCount) modalPageCount.textContent = (idx + 1) + ' / ' + ids.length;

      try {
        const highResUrl = await getHighResImage(record);
        // Si mientras tanto se navegó a otra hoja o se cerró el modal,
        // esta respuesta ya está obsoleta — se descarta sin aplicarla.
        if (myToken !== modalState.requestToken || modalState.currentId !== targetId) return;
        modalImage.src = highResUrl;
      } catch (e) {
        console.error('Error al generar vista en alta resolución:', e);
        if (myToken === modalState.requestToken) {
          showToast('No se pudo generar la vista nítida de esta hoja; se muestra la miniatura.', 'warning');
        }
      } finally {
        if (myToken === modalState.requestToken) {
          if (modalLoader) modalLoader.classList.add('hidden');
        }
      }
    }

    if (modalToolsEl) {
      modalToolsEl.innerHTML = buildCardToolsHTML();
      modalToolsEl.querySelectorAll('.card-tool').forEach(btn => {
        btn.addEventListener('click', () => {
          if (!modalState.currentId) return;
          applyTransform(modalState.currentId, btn.dataset.action, modalScopeIds());
        });
      });
    }

    // Alcance de una acción lanzada DESDE el modal: la hoja visible, o todas
    // si el usuario marcó "Aplicar a todas" en esa misma barra.
    function modalScopeIds() {
      const applyAll = modalApplyAll && modalApplyAll.checked;
      return applyAll
        ? getNavigablePages().map(p => p.id)
        : (modalState.currentId ? [modalState.currentId] : []);
    }

    const modalForceVertical   = document.getElementById('modal-force-vertical');
    const modalForceHorizontal = document.getElementById('modal-force-horizontal');
    if (modalForceVertical) {
      modalForceVertical.addEventListener('click', () => forceOrientation('vertical', modalScopeIds()));
    }
    if (modalForceHorizontal) {
      modalForceHorizontal.addEventListener('click', () => forceOrientation('horizontal', modalScopeIds()));
    }

    if (modalPrevBtn) modalPrevBtn.addEventListener('click', () => navigateModal(-1));
    if (modalNextBtn) modalNextBtn.addEventListener('click', () => navigateModal(1));
    if (modalCloseBtn) modalCloseBtn.addEventListener('click', closeModal);
    if (modalBackdrop) modalBackdrop.addEventListener('click', closeModal);

    /* ═══════════════════════════════════════════════
       CREAR TARJETA EN DOM
       ═══════════════════════════════════════════════ */
    function createCardInDOM(data) {
      const card = document.createElement('div');
      card.className = 'page-card';
      if (data.isWord) card.classList.add('word-page');
      else if (data.isImage) card.classList.add('image-page');
      else card.classList.add('pdf-page');
      card.dataset.id = data.id;
      card.dataset.fileId = data.fileId;
      card.dataset.pageIndex = data.pageIndex;
      card.setAttribute('tabindex', '0');
      card.setAttribute('role', 'listitem');

      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-page') || e.target.closest('.card-tool')) return;
        // Una hoja agrupada no se selecciona individualmente — sus acciones
        // se hacen a nivel de bloque (ver el header del .page-group). Sin
        // este freno, Ctrl+A + Supr podía borrar UNA hoja de adentro de un
        // bloque y dejarlo roto a medias.
        if (card.classList.contains('in-group')) return;
        if (e.ctrlKey || e.metaKey) {
          card.classList.toggle('selected');
        } else if (e.shiftKey) {
          const cards = Array.from(workspace.querySelectorAll('.page-card'));
          const lastSelected = workspace.querySelector('.page-card.selected:last-of-type');
          if (lastSelected) {
            const idxA = cards.indexOf(lastSelected);
            const idxB = cards.indexOf(card);
            const [from, to] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
            cards.forEach((c, i) => {
              if (i >= from && i <= to) c.classList.add('selected');
            });
          } else {
            card.classList.toggle('selected');
          }
        } else {
          if (!card.classList.contains('selected')) {
            document.querySelectorAll('.page-card.selected').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
          }
        }
        updateSelectionUI();
      });

      card.addEventListener('dblclick', (e) => {
        if (e.target.closest('.btn-delete-page') || e.target.closest('.card-tool')) return;
        openModal(data.id);
      });

      // Botón eliminar
      const btnDel = document.createElement('button');
      btnDel.className = 'btn-delete-page';
      btnDel.innerHTML = '✖';
      btnDel.setAttribute('aria-label', 'Eliminar página');
      btnDel.addEventListener('click', (e) => {
        e.stopPropagation();
        const selected = document.querySelectorAll('.page-card.selected');
        const isGroupDelete = selected.length > 1 && card.classList.contains('selected');
        if (isGroupDelete && !window.confirm('¿Eliminar ' + selected.length + ' hojas seleccionadas? Puedes deshacerlo después con Ctrl+Z.')) {
          return;
        }
        withUndo(() => {
          if (selected.length > 0 && card.classList.contains('selected')) {
            selected.forEach(c => c.remove());
          } else {
            card.remove();
          }
          syncRegistryWithDOM();
        });
        // Si la hoja borrada era la que se veía en el modal, se cierra sola
        // en vez de quedar mostrando una página que ya no existe.
        if (modalState.currentId && !pageRegistry.find(p => p.id === modalState.currentId)) {
          closeModal();
        }
        // Fix (deshacer eliminaba el archivo original de la hoja): ya no se
        // limpia el buffer fuente de golpe al vaciar el workspace — se
        // libera solo lo que ya no referencia ni el workspace ni el
        // historial de deshacer/rehacer (ver pruneUnreferencedFileData).
        pruneUnreferencedFileData();
        updateSelectionUI();
        flashPageCountBadge();
      });

      // Marco recortado + imagen miniatura
      const frame = document.createElement('div');
      frame.className = 'page-image-frame';

      const img = document.createElement('img');
      img.className = 'page-image';
      img.src = data.thumb;
      img.setAttribute('alt', data.isImage ? 'Imagen ' + (data.pageIndex + 1) : data.isWord ? 'Hoja Word ' + (data.pageIndex + 1) : 'Página PDF ' + (data.pageIndex + 1));
      frame.appendChild(img);

      if (data.isWord) {
        const wordBadge = document.createElement('span');
        wordBadge.className = 'word-badge';
        wordBadge.textContent = 'W';
        card.appendChild(wordBadge);
      } else if (data.isImage) {
        const imageBadge = document.createElement('span');
        imageBadge.className = 'image-badge';
        imageBadge.textContent = 'IMG';
        card.appendChild(imageBadge);
      } else {
        const pdfBadge = document.createElement('span');
        pdfBadge.className = 'pdf-badge';
        pdfBadge.textContent = 'PDF';
        card.appendChild(pdfBadge);
      }

      // Herramientas de rotación/espejo (Requerimiento #2)
      const toolsWrapper = document.createElement('div');
      toolsWrapper.innerHTML = buildCardToolsHTML();
      const toolsEl = toolsWrapper.firstElementChild;
      toolsEl.querySelectorAll('.card-tool').forEach(btn => {
        btn.tabIndex = -1; // arranca fuera del orden de tabulación (no seleccionada aún)
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          applyTransform(data.id, btn.dataset.action);
        });
      });

      card.appendChild(btnDel);
      card.appendChild(frame);
      card.appendChild(toolsEl);
      workspace.appendChild(card);
    }

    /* Construye SOLO el DOM de una tarjeta de fallo a partir de un registro
       ya existente — separado de createFailedCard() para que deshacer/
       rehacer pueda reconstruir la tarjeta sin volver a empujarla al
       registro (ya está ahí, restaurada desde el historial). */
    function createFailedCardDOM(record) {
      const card = document.createElement('div');
      card.className = 'page-card page-failed';
      card.dataset.id = record.id;
      card.dataset.fileId = record.fileId;
      card.dataset.pageIndex = record.pageIndex;

      const icon = document.createElement('div');
      icon.className = 'failed-icon';
      icon.textContent = '⚠️';

      const text = document.createElement('div');
      text.className = 'failed-text';
      text.textContent = record.reason || 'Error';

      card.appendChild(icon);
      card.appendChild(text);
      workspace.appendChild(card);
    }

    function createFailedCard(fileId, pageIdx, reason) {
      const record = {
        id: fileId + '_failed_' + pageIdx,
        fileId,
        pageIndex: pageIdx,
        rotation: 0,
        mirrorH: false,
        mirrorV: false,
        thumb: null,
        isFailed: true,
        reason
      };
      pageRegistry.push(record);
      createFailedCardDOM(record);
    }

    /* ═══════════════════════════════════════════════
       BLOQUE: trabajar un archivo completo como una sola
       unidad en vez de hoja por hoja
       ═══════════════════════════════════════════════
       El agrupamiento es una capa por encima del registro plano de
       páginas: cada página agrupada guarda su groupId/groupFileName
       (sobrevive a deshacer/rehacer, que reconstruye el DOM desde el
       registro — ver rebuildWorkspaceFromRegistry), y en el workspace se
       ve como UN solo contenedor arrastrable/eliminable. La generación del
       PDF final, el foleo y la navegación del modal no cambian en nada:
       siguen recorriendo pageRegistry página por página, tal cual. */
    function askKeepAsBlock(fileName, pageCount) {
      return window.confirm(
        '"' + fileName + '" tiene ' + pageCount + ' páginas.\n\n' +
        'Aceptar = mantenerlo como UN SOLO bloque (se arrastra, elimina y rota junto, no hoja por hoja). Podrás "Desagrupar" después, sin volver a adjuntarlo.\n' +
        'Cancelar = desglosarlo en páginas individuales, como de costumbre.'
      );
    }

    function tagRecordsAsGroup(ids, groupId, fileName) {
      ids.forEach(id => {
        const r = pageRegistry.find(p => p.id === id);
        if (r) { r.groupId = groupId; r.groupFileName = fileName; }
      });
    }

    function untagGroup(ids) {
      ids.forEach(id => {
        const r = pageRegistry.find(p => p.id === id);
        if (r) { delete r.groupId; delete r.groupFileName; }
      });
    }

    function groupMemberIds(wrapper) {
      return Array.from(wrapper.querySelectorAll('.page-card')).map(c => c.dataset.id);
    }

    /* Arma el <div class="page-group"> (header con nombre/acciones + franja
       de miniaturas) y MUEVE los elementos de `memberCardEls` a su interior
       — no los clona, así que cualquier listener que ya tuvieran (doble
       clic para el modal, etc.) sigue funcionando tal cual. */
    function buildGroupWrapperDOM(groupId, fileName, memberCardEls) {
      const wrapper = document.createElement('div');
      wrapper.className = 'page-group';
      wrapper.dataset.groupId = groupId;
      wrapper.setAttribute('role', 'group');
      wrapper.setAttribute('aria-label', fileName + ', bloque de ' + memberCardEls.length + ' hojas');

      const header = document.createElement('div');
      header.className = 'page-group-header';

      const title = document.createElement('span');
      title.className = 'page-group-title';
      title.textContent = '📄 ' + fileName + ' · ' + memberCardEls.length + ' hojas';
      title.title = fileName + ' (' + memberCardEls.length + ' hojas, agrupadas como bloque único)';
      header.appendChild(title);

      const actions = document.createElement('div');
      actions.className = 'page-group-actions';

      const toolsWrapper = document.createElement('div');
      toolsWrapper.innerHTML = buildCardToolsHTML();
      const toolsEl = toolsWrapper.firstElementChild;
      toolsEl.setAttribute('aria-label', 'Rotar y espejar el bloque completo');
      toolsEl.querySelectorAll('.card-tool').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          applyTransform(null, btn.dataset.action, groupMemberIds(wrapper));
        });
      });
      actions.appendChild(toolsEl);

      const btnUngroup = document.createElement('button');
      btnUngroup.type = 'button';
      btnUngroup.className = 'btn-ungroup';
      btnUngroup.textContent = 'Desagrupar';
      btnUngroup.title = 'Volver a páginas individuales, sin re-adjuntar el archivo';
      btnUngroup.addEventListener('click', (e) => {
        e.stopPropagation();
        ungroupBlock(wrapper);
      });
      actions.appendChild(btnUngroup);

      const btnDelGroup = document.createElement('button');
      btnDelGroup.type = 'button';
      btnDelGroup.className = 'btn-delete-page';
      btnDelGroup.innerHTML = '✖';
      btnDelGroup.setAttribute('aria-label', 'Eliminar el bloque completo');
      btnDelGroup.title = 'Eliminar todo el bloque';
      btnDelGroup.addEventListener('click', (e) => {
        e.stopPropagation();
        const memberIds = groupMemberIds(wrapper);
        if (!window.confirm('¿Eliminar el bloque completo "' + fileName + '" (' + memberIds.length + ' hojas)? Puedes deshacerlo después con Ctrl+Z.')) {
          return;
        }
        withUndo(() => {
          wrapper.remove();
          syncRegistryWithDOM();
        });
        if (modalState.currentId && !pageRegistry.find(p => p.id === modalState.currentId)) closeModal();
        pruneUnreferencedFileData();
        updateSelectionUI();
        flashPageCountBadge();
      });
      actions.appendChild(btnDelGroup);

      header.appendChild(actions);
      wrapper.appendChild(header);

      const strip = document.createElement('div');
      strip.className = 'page-group-strip';
      memberCardEls.forEach(card => {
        card.classList.add('in-group');
        card.dataset.groupId = groupId;
        strip.appendChild(card);
      });
      wrapper.appendChild(strip);

      return wrapper;
    }

    /* Convierte `cardIds` (ya renderizados como tarjetas normales, recién
       creadas para un mismo archivo) en un bloque único. */
    function wrapCardsIntoGroup(cardIds, fileName) {
      if (cardIds.length < 2) return; // agrupar una sola hoja no aporta nada
      const memberCardEls = cardIds.map(id => document.querySelector('[data-id="' + id + '"]')).filter(Boolean);
      if (memberCardEls.length < 2) return;
      const parent = memberCardEls[0].parentNode;
      if (!parent) return;
      // Punto de inserción capturado ANTES de mover ninguna tarjeta —
      // nunca es una de las que se está moviendo, así que sigue siendo
      // válido después de que buildGroupWrapperDOM las reubique.
      const refNode = memberCardEls[memberCardEls.length - 1].nextSibling;
      const groupId = 'grp_' + generateId();
      const wrapper = buildGroupWrapperDOM(groupId, fileName, memberCardEls);
      parent.insertBefore(wrapper, refNode);
      tagRecordsAsGroup(cardIds, groupId, fileName);
    }

    /* Deshace un bloque: las hojas vuelven a ser tarjetas individuales,
       reordenables/eliminables una por una, en la misma posición donde
       estaba el bloque — sin volver a adjuntar el archivo. */
    function ungroupBlock(wrapper) {
      const memberIds = groupMemberIds(wrapper);
      const memberCards = Array.from(wrapper.querySelectorAll('.page-card'));
      memberCards.forEach(card => {
        card.classList.remove('in-group');
        delete card.dataset.groupId;
        wrapper.parentNode.insertBefore(card, wrapper);
      });
      wrapper.remove();
      untagGroup(memberIds);
      syncRegistryWithDOM();
      updateSelectionUI();
      showToast('Bloque desagrupado — ' + memberIds.length + ' hojas individuales.', 'success');
    }

    /* ═══════════════════════════════════════════════
       RANGO DE PÁGINAS AL ADJUNTAR UN PDF GRANDE
       Antes de repartir un PDF de muchas páginas en tarjetas, se ofrece
       elegir solo un rango — con vista previa real de la primera y la
       última página del rango (no solo números), para no equivocarse de
       tramo en un documento de cientos de páginas. ═══════════════════════════════════════════════ */
    const RANGE_PROMPT_THRESHOLD = 15;
    const rangeModal          = document.getElementById('range-modal');
    const rangeModalBackdrop  = document.getElementById('range-modal-backdrop');
    const rangeModalFilename  = document.getElementById('range-modal-filename');
    const rangeFromInput      = document.getElementById('range-from');
    const rangeToInput        = document.getElementById('range-to');
    const rangeCountLabel     = document.getElementById('range-count-label');
    const rangeTotalCountEl   = document.getElementById('range-total-count');
    const rangePreviewFrom    = document.getElementById('range-preview-from');
    const rangePreviewTo      = document.getElementById('range-preview-to');
    const btnRangeAll         = document.getElementById('btn-range-all');
    const btnRangeApply       = document.getElementById('btn-range-apply');

    async function renderRangePreviewPage(pdfDoc, pageNum) {
      try {
        const page = await pdfDoc.getPage(pageNum);
        const viewport = page.getViewport({ scale: 0.25 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
        canvas.width = 0;
        return dataUrl;
      } catch (e) {
        return '';
      }
    }

    /* Muestra el modal y devuelve una Promise que resuelve con
       {from, to} (1-based, inclusive) si el usuario elige un rango, o
       `null` si elige cargar todas las páginas. */
    function askPageRange(fileName, totalPages, pdfDoc) {
      return new Promise(resolve => {
        if (!rangeModal) { resolve(null); return; }

        rangeModalFilename.textContent = fileName;
        rangeTotalCountEl.textContent = String(totalPages);
        rangeFromInput.value = 1;
        rangeFromInput.max = totalPages;
        rangeToInput.value = totalPages;
        rangeToInput.max = totalPages;
        rangeModal.classList.remove('hidden');

        const clampToTotal = v => Math.max(1, Math.min(totalPages, v || 1));
        let previewToken = 0;

        async function updatePreview() {
          const myToken = ++previewToken;
          const from = clampToTotal(parseInt(rangeFromInput.value));
          const to = clampToTotal(parseInt(rangeToInput.value));
          rangeCountLabel.textContent = Math.max(0, to - from + 1) + ' página(s) de ' + totalPages;
          const [fromUrl, toUrl] = await Promise.all([
            renderRangePreviewPage(pdfDoc, Math.min(from, to)),
            renderRangePreviewPage(pdfDoc, Math.max(from, to)),
          ]);
          if (myToken !== previewToken) return; // el usuario ya siguió cambiando los números
          if (fromUrl) rangePreviewFrom.src = fromUrl;
          if (toUrl) rangePreviewTo.src = toUrl;
        }

        const onInput = () => updatePreview();
        rangeFromInput.addEventListener('input', onInput);
        rangeToInput.addEventListener('input', onInput);

        function cleanup() {
          rangeFromInput.removeEventListener('input', onInput);
          rangeToInput.removeEventListener('input', onInput);
          btnRangeAll.onclick = null;
          btnRangeApply.onclick = null;
          rangeModalBackdrop.onclick = null;
          rangeModal.classList.add('hidden');
        }

        btnRangeAll.onclick = () => { cleanup(); resolve(null); };
        btnRangeApply.onclick = () => {
          const from = clampToTotal(parseInt(rangeFromInput.value));
          const to = clampToTotal(parseInt(rangeToInput.value));
          cleanup();
          resolve({ from: Math.min(from, to), to: Math.max(from, to) });
        };
        // Cerrar haciendo clic fuera del cuadro equivale a "cargar todas" —
        // nunca deja al usuario sin ninguna opción tomada.
        rangeModalBackdrop.onclick = () => { cleanup(); resolve(null); };

        updatePreview();
      });
    }

    /* ═══════════════════════════════════════════════
       PROCESAR PDF
       ═══════════════════════════════════════════════ */
    async function processPDF(file, fileId, buffer) {
      if (!isValidPDF(buffer)) {
        showToast('El archivo "' + file.name + '" no es un PDF válido.', 'error');
        return;
      }

      let loadingTask;
      try {
        loadingTask = pdfjsLib.getDocument({ data: buffer });
        const pdf = await loadingTask.promise;
        const totalPages = pdf.numPages;

        // PDF grande: se ofrece elegir un rango antes de repartirlo en
        // tarjetas, con vista previa real de sus páginas límite.
        let fromPage = 1, toPage = totalPages;
        if (totalPages > RANGE_PROMPT_THRESHOLD) {
          const chosen = await askPageRange(file.name, totalPages, pdf);
          if (chosen) {
            fromPage = chosen.from;
            toPage = chosen.to;
            showToast('Cargando páginas ' + fromPage + '–' + toPage + ' de "' + file.name + '" (' + (toPage - fromPage + 1) + ' de ' + totalPages + ').', 'info');
          }
        }
        const rangeCount = toPage - fromPage + 1;

        for (let i = fromPage; i <= toPage; i++) {
          // Fix #7: límite duro de páginas totales para proteger la memoria del navegador
          if (pageRegistry.length >= MAX_TOTAL_PAGES) {
            showToast('Se alcanzó el límite de ' + MAX_TOTAL_PAGES + ' páginas. El resto de "' + file.name + '" no se cargó.', 'warning');
            break;
          }

          updateProgress(i - fromPage + 1, rangeCount);
          if ((i - fromPage) % 5 === 0) await new Promise(r => setTimeout(r, 1));

          const pageId = fileId + '_' + i;
          try {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 0.15 });
            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

            const nodeData = {
              id: pageId,
              fileId,
              pageIndex: i - 1,
              rotation: 0,
              mirrorH: false,
              mirrorV: false,
              baseOrientation: viewport.width > viewport.height ? 'horizontal' : 'vertical',
              // Proporción real de la hoja (la ratio es la misma a cualquier
              // escala, así que se reutiliza el viewport ya calculado sin
              // costo extra) — usada para dimensionar el marco del modal.
              nativeWidth: viewport.width,
              nativeHeight: viewport.height,
              thumb: canvas.toDataURL('image/jpeg', 0.5),
              isWord: false
            };
            pageRegistry.push(nodeData);
            createCardInDOM(nodeData);
            canvas.width = 0;
          } catch (pageErr) {
            console.error('Error página ' + i + ':', pageErr);
            createFailedCard(fileId, i - 1, 'Pág ' + i);
          }
        }
        await pdf.destroy();
      } catch (err) {
        console.error('Error PDF:', err);
        showToast('Error al leer: ' + file.name, 'error');
      } finally {
        if (loadingTask) {
          try { loadingTask.destroy(); } catch (e) { /* silencioso */ }
        }
      }
    }

    /* ═══════════════════════════════════════════════
       PARTIR HOJAS WORD QUE DESBORDAN UNA PÁGINA
       docx-preview solo corta una hoja nueva cuando el propio
       .docx trae esa información (salto de página manual, o el
       marcador "lastRenderedPageBreak" que Word graba la última
       vez que el archivo se abrió/imprimió allí — se le pide
       explícitamente que lo use, ver processWord). Un documento
       generado por script, o nunca abierto en Word tras su
       última edición, puede no traer esa marca: en ese caso
       docx-preview entrega UNA sola sección que simplemente
       crece más allá de una hoja, en vez de partirse.
       Esta función detecta ese desborde y reparte el contenido
       YA renderizado (sin tocar una sola letra ni estilo) en
       tantas hojas como haga falta, midiendo la altura real de
       cada párrafo/tabla — el mismo método de "altura acumulada"
       ya usado y probado en versiones anteriores de esta app,
       aplicado ahora sobre el HTML fiel de docx-preview en vez
       del HTML simplificado que entregaba mammoth.js. ═══════════════════════════════════════════════ */
    function splitOverflowingDocxSections(container) {
      const sections = Array.from(container.querySelectorAll(':scope > section.docx'));
      const finalSections = [];

      sections.forEach(section => {
        const article = section.querySelector(':scope > article');
        if (!article) { finalSections.push(section); return; }

        const cs = getComputedStyle(section);
        const paddingTop = parseFloat(cs.paddingTop) || 0;
        const paddingBottom = parseFloat(cs.paddingBottom) || 0;
        const nominalPageHeightPx = parseFloat(cs.minHeight) || section.offsetHeight;
        const contentBudgetPx = nominalPageHeightPx - paddingTop - paddingBottom;

        const children = Array.from(article.childNodes).filter(n =>
          n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim().length > 0)
        );

        let acc = 0;
        const pagesNodes = [[]];
        children.forEach(node => {
          const h = (node.nodeType === 1 && typeof node.offsetHeight === 'number') ? node.offsetHeight : 18;
          if (acc + h > contentBudgetPx && pagesNodes[pagesNodes.length - 1].length > 0) {
            pagesNodes.push([]);
            acc = 0;
          }
          pagesNodes[pagesNodes.length - 1].push(node);
          acc += h;
        });

        if (pagesNodes.length <= 1) { finalSections.push(section); return; }

        // El encabezado/pie de página (si el documento tiene) se repite
        // igual en cada hoja nueva — así es como Word los muestra.
        const header = section.querySelector(':scope > header');
        const footer = section.querySelector(':scope > footer');

        pagesNodes.forEach(nodesForPage => {
          const newSection = section.cloneNode(false); // copia clase + tamaño/margen reales, sin hijos
          if (header) newSection.appendChild(header.cloneNode(true));
          const newArticle = article.cloneNode(false);
          nodesForPage.forEach(n => newArticle.appendChild(n.cloneNode(true)));
          newSection.appendChild(newArticle);
          if (footer) newSection.appendChild(footer.cloneNode(true));
          container.insertBefore(newSection, section);
          finalSections.push(newSection);
        });
        section.remove();
      });

      return finalSections;
    }

    /* Espera a que cada <img> de la hoja Word termine de intentar decodificar
       (cargó bien, o falló) y reemplaza cualquiera que NO haya podido
       decodificarse por un aviso visible del mismo tamaño, en vez de dejarla
       desaparecer en silencio. Causa real confirmada: algunas imágenes
       incrustadas en Word usan formatos que NINGÚN navegador sabe mostrar
       (el caso típico: WMF/EMF, muy común en logos o "cuadros" pegados hace
       años en plantillas institucionales) — el <img> nunca se pinta, pero
       tampoco lanza ningún error que la app pudiera atrapar antes de esto,
       así que la hoja se daba por exitosa con esa imagen (o el "cuadro" que
       en realidad era una imagen) simplemente ausente. Devuelve cuántas
       imágenes rotas encontró, para poder avisarle al usuario. */
    async function waitForImagesAndMarkBroken(container, timeoutMs) {
      const imgs = Array.from(container.querySelectorAll('img'));
      if (imgs.length === 0) return 0;

      await Promise.all(imgs.map(img => {
        if (img.complete) return Promise.resolve();
        return Promise.race([
          new Promise(resolve => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
          }),
          new Promise(resolve => setTimeout(resolve, timeoutMs))
        ]);
      }));

      let brokenCount = 0;
      imgs.forEach(img => {
        if (!img.complete || !img.naturalWidth || !img.naturalHeight) {
          brokenCount++;
          const rect = img.getBoundingClientRect();
          const w = Math.max(60, img.width || rect.width || 160);
          const h = Math.max(30, img.height || rect.height || 90);
          const placeholder = document.createElement('div');
          placeholder.style.cssText =
            'display:inline-block;box-sizing:border-box;width:' + w + 'px;height:' + h + 'px;' +
            'border:2px dashed #c0392b;background:#fdecea;color:#a12a20;font-size:10px;' +
            'line-height:1.3;text-align:center;padding:4px;overflow:hidden;' +
            'font-family:Arial,sans-serif;vertical-align:middle;';
          placeholder.textContent = 'IMAGEN NO COMPATIBLE — formato no soportado por el navegador (ej. WMF/EMF). Reinsértela como PNG/JPG en Word.';
          if (img.parentNode) img.parentNode.replaceChild(placeholder, img);
        }
      });
      return brokenCount;
    }

    /* Marca de forma visible cualquier objeto incrustado que docx-preview no
       sabe dibujar — la causa real, confirmada con una reproducción exacta,
       de "cuadros"/gráficos que desaparecían en silencio (a diferencia de
       las imágenes rotas, que sí dejan un <img>, esto ni siquiera eso: el
       hueco queda del tamaño correcto pero completamente vacío). docx-preview
       solo sabe dibujar IMÁGENES (pic:pic) dentro de un <w:drawing> — un
       GRÁFICO nativo de Word/Excel (creado con datos, no pegado como una
       simple imagen), un SmartArt, una forma de texto u otro objeto
       incrustado se procesan igual por dentro (se calcula y se reserva su
       tamaño real), pero como no hay motor para "dibujarlos", el contenedor
       queda vacío — ni un error, ni un aviso, solo un espacio en blanco del
       tamaño exacto que debía ocupar el gráfico. Cada objeto de este tipo
       se envuelve siempre en el mismo contenedor
       (display:inline-block;position:relative), así que un <div> con esa
       combinación exacta y CERO contenido dentro es, por descarte, uno de
       estos objetos no soportados. */
    function markUnsupportedDrawings(container) {
      const candidates = Array.from(container.querySelectorAll('div')).filter(div =>
        div.style.display === 'inline-block' &&
        div.style.position === 'relative' &&
        div.children.length === 0 &&
        !div.textContent.trim()
      );
      candidates.forEach(div => {
        div.style.cssText +=
          ';border:2px dashed #c0392b;background:#fdecea;color:#a12a20;font-size:10px;' +
          'line-height:1.3;text-align:center;box-sizing:border-box;padding:4px;overflow:hidden;' +
          'font-family:Arial,sans-serif;vertical-align:middle;';
        div.textContent = 'OBJETO NO COMPATIBLE — gráfico/SmartArt/objeto incrustado que el navegador no puede mostrar. En Word: clic derecho sobre él → "Guardar como imagen" (o "Convertir en imagen") y reinsértelo como PNG/JPG.';
      });
      return candidates.length;
    }

    /* ═══════════════════════════════════════════════
       PROCESAR WORD (DOCX) → renderizar como imagen
       Motor: docx-preview (reemplaza a mammoth.js). mammoth
       convierte el .docx a HTML "limpio" y por diseño DESCARTA
       la alineación/color/tamaño de fuente puestos a mano si no
       vienen de un estilo con nombre — la causa raíz, confirmada
       con evidencia, del reclamo recurrente de "se altera el
       formato/data de Word" (ver CAMBIOS.md, Ronda 7). docx-preview
       en cambio lee el XML del .docx igual que lo hace Word al
       abrirlo, y aplica cada propiedad de párrafo/carácter tal
       cual está en el archivo — manual o de un estilo, da igual —
       nada se "limpia" ni se pierde. Además entrega el tamaño y
       los márgenes REALES de cada hoja (de su w:pgSz/w:pgMar), así
       que ya no hace falta inventar un margen propio ni forzar A4:
       la hoja final es exactamente la del documento original.
       ═══════════════════════════════════════════════ */
    async function processWord(file, fileId, buffer) {
      if (!isValidDOCX(buffer)) {
        showToast('El archivo "' + file.name + '" no es un DOCX válido.', 'error');
        return;
      }
      if (!DOCXPREVIEW_OK) {
        showToast('Librería docx-preview no disponible. No se puede procesar Word.', 'error');
        return;
      }
      // Fix #4: si html2canvas no cargó, se aborta ANTES de generar nada,
      // en vez de crear hojas en blanco silenciosas.
      if (!HTML2CANVAS_OK) {
        showToast('html2canvas no disponible: "' + file.name + '" no se procesó (se habría generado en blanco).', 'error');
        return;
      }

      // Contenedores de renderizado fuera de pantalla, con "position:fixed"
      // para sacarlos por completo del flujo de <body> (que usa
      // display:flex para centrar la tarjeta principal de la app). Sin
      // esto, cualquier hijo directo de body puede ser encogido por el
      // layout flex sin importar su ancho fijo — la causa confirmada de un
      // bug grave anterior ("contenido pegado a la izquierda, A4 perdido",
      // ver CAMBIOS.md Ronda 8). El mismo truco ya usado ahí se reaplica aquí.
      const renderContainer = document.createElement('div');
      renderContainer.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
      const styleContainer = document.createElement('div');
      styleContainer.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
      document.body.appendChild(renderContainer);
      document.body.appendChild(styleContainer);

      try {
        await docx.renderAsync(buffer, renderContainer, styleContainer, {
          inWrapper: false,                    // sin el fondo gris de "vista previa": cada hoja es su propia sección
          breakPages: true,
          ignoreLastRenderedPageBreak: false,   // usa el paginado real de Word cuando el archivo lo trae
          experimental: true,                   // posición exacta de tabulaciones
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          useBase64URL: true,                   // imágenes ya incrustadas como data: — sin esperas de red
          className: 'docx',
        });

        // "experimental" reajusta las tabulaciones en un setTimeout interno
        // de 500ms que renderAsync no espera — sin este margen, una hoja
        // con tabulaciones se capturaría antes de que terminen de reubicarse.
        await new Promise(r => setTimeout(r, 650));
        if (document.fonts && document.fonts.ready) {
          await Promise.race([document.fonts.ready.catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
        }

        // Fix (imágenes/"cuadros" que desaparecían en silencio): antes de
        // capturar nada, se detecta y se marca visiblemente cualquier
        // imagen que el navegador no pudo decodificar — ver el comentario
        // junto a waitForImagesAndMarkBroken.
        const brokenImageCount = await waitForImagesAndMarkBroken(renderContainer, 4000);
        if (brokenImageCount > 0) {
          showToast(
            '⚠️ "' + file.name + '" trae ' + brokenImageCount + ' imagen(es) en un formato que el navegador no puede mostrar (común en imágenes antiguas tipo WMF/EMF). Quedaron marcadas en el PDF — ábralas en Word, guárdelas como PNG/JPG y vuelva a insertarlas.',
            'warning'
          );
        }

        // Fix (gráficos/"cuadros" y otros objetos incrustados que
        // desaparecían en silencio): ver el comentario junto a
        // markUnsupportedDrawings — a diferencia de una imagen rota, estos
        // ni siquiera dejan un <img>, así que necesitan su propia detección.
        const unsupportedDrawingCount = markUnsupportedDrawings(renderContainer);
        if (unsupportedDrawingCount > 0) {
          showToast(
            '⚠️ "' + file.name + '" trae ' + unsupportedDrawingCount + ' gráfico(s)/objeto(s) incrustado(s) (ej. un gráfico nativo de Excel/Word, SmartArt) que el navegador no puede mostrar. Quedaron marcados en el PDF — en Word, clic derecho sobre cada uno → "Guardar como imagen", y reinsértelos como PNG/JPG.',
            'warning'
          );
        }

        const pageSections = splitOverflowingDocxSections(renderContainer);

        if (pageSections.length === 0) {
          showToast('El documento "' + file.name + '" está vacío o no se pudo paginar.', 'warning');
          return;
        }

        for (let p = 0; p < pageSections.length; p++) {
          if (pageRegistry.length >= MAX_TOTAL_PAGES) {
            showToast('Se alcanzó el límite de ' + MAX_TOTAL_PAGES + ' páginas. El resto de "' + file.name + '" no se cargó.', 'warning');
            break;
          }
          updateProgress(p + 1, pageSections.length);

          const sectionEl = pageSections[p];
          // Tamaño REAL de esta hoja (ancho/alto en puntos), leído directo
          // del estilo que docx-preview calculó a partir de w:pgSz — nunca
          // se fuerza a A4: si el documento define otro tamaño, se respeta.
          const pageWpt = parseFloat(sectionEl.style.width) || 595.28;
          const pageHpt = parseFloat(sectionEl.style.minHeight) || 841.89;

          try {
            const canvas = await html2canvas(sectionEl, { scale: 2.5, useCORS: true, logging: false });
            const pageId = fileId + '_w_' + (p + 1);
            const nodeData = {
              id: pageId,
              fileId,
              pageIndex: p,
              rotation: 0,
              mirrorH: false,
              mirrorV: false,
              baseOrientation: pageWpt > pageHpt ? 'horizontal' : 'vertical',
              nativeWidth: pageWpt,
              nativeHeight: pageHpt,
              thumb: canvas.toDataURL('image/jpeg', 0.88),
              isWord: true
            };
            pageRegistry.push(nodeData);
            createCardInDOM(nodeData);
            canvas.width = 0;
          } catch (e) {
            console.error('Error al capturar hoja Word ' + (p + 1), e);
            createFailedCard(fileId, p, 'Word pág ' + (p + 1));
          }
        }
      } catch (err) {
        console.error('Error Word:', err);
        showToast('Error al procesar: ' + file.name, 'error');
      } finally {
        document.body.removeChild(renderContainer);
        document.body.removeChild(styleContainer);
      }
    }

    /* ═══════════════════════════════════════════════
       PROCESAR IMAGEN (PNG/JPG/WEBP/GIF) → una hoja, tal cual
       ═══════════════════════════════════════════════
       A diferencia de Word (que compone su contenido dentro de un A4 con
       márgenes), una imagen suelta se trata como una hoja escaneada: se
       preserva su propia proporción, y en el PDF final ocupa toda la hoja
       (sin recortar ni forzar A4) — así una foto o un escaneo apaisado no
       sale distorsionado ni con bordes blancos artificiales.
       PNG/JPG se incrustan con sus bytes originales, tal cual. WEBP/GIF el
       navegador SÍ los decodifica, pero pdf-lib no tiene un embedWebp/
       embedGif propio — se recomponen a PNG (sin pérdida de lo que el
       navegador ya decodificó, mismos píxeles) y esa versión reemplaza al
       buffer en imageDocumentsData, avisando siempre por qué. */
    async function processImage(file, fileId, buffer, kind) {
      const mimeType = kind === 'png' ? 'image/png' : kind === 'jpeg' ? 'image/jpeg' : kind === 'webp' ? 'image/webp' : 'image/gif';

      if (pageRegistry.length >= MAX_TOTAL_PAGES) {
        showToast('Ya alcanzaste el límite de ' + MAX_TOTAL_PAGES + ' páginas en el workspace.', 'error');
        return;
      }

      const blob = new Blob([buffer], { type: mimeType });
      const objectUrl = URL.createObjectURL(blob);
      try {
        const img = await loadImageElement(objectUrl);
        const pxW = img.naturalWidth, pxH = img.naturalHeight;
        if (!pxW || !pxH) throw new Error('Dimensiones de imagen inválidas');

        if (kind === 'webp' || kind === 'gif') {
          const fullCanvas = document.createElement('canvas');
          fullCanvas.width = pxW;
          fullCanvas.height = pxH;
          fullCanvas.getContext('2d').drawImage(img, 0, 0);
          const pngBytes = await fetch(fullCanvas.toDataURL('image/png')).then(r => r.arrayBuffer());
          imageDocumentsData.set(fileId, { buffer: pngBytes, name: file.name, mimeType: 'image/png' });
          fullCanvas.width = 0;
          showToast(
            '"' + file.name + '" (' + kind.toUpperCase() + ') se recompuso a PNG sin pérdida de calidad para poder incrustarla en el PDF (esa librería no admite ' + kind.toUpperCase() + ' de forma nativa).' +
            (kind === 'gif' ? ' Si el GIF es animado, en el PDF se usa solo su primer cuadro.' : ''),
            'info'
          );
        }

        // Conversión px → puntos PDF asumiendo ~96dpi (resolución típica de
        // capturas/escaneos livianos). Si la imagen es muy grande (foto de
        // celular de varios miles de px), se reescala para no generar una
        // hoja del tamaño de un mural mientras se conserva la proporción.
        const PT_PER_PX = 72 / 96;
        let nativeWidth = pxW * PT_PER_PX;
        let nativeHeight = pxH * PT_PER_PX;
        const MAX_DIM = 1191; // ≈ lado mayor de A3 en puntos
        if (Math.max(nativeWidth, nativeHeight) > MAX_DIM) {
          const shrink = MAX_DIM / Math.max(nativeWidth, nativeHeight);
          nativeWidth *= shrink;
          nativeHeight *= shrink;
        }

        const thumbCanvas = document.createElement('canvas');
        const thumbScale = Math.min(1, 320 / Math.max(pxW, pxH));
        thumbCanvas.width = Math.max(1, Math.round(pxW * thumbScale));
        thumbCanvas.height = Math.max(1, Math.round(pxH * thumbScale));
        thumbCanvas.getContext('2d').drawImage(img, 0, 0, thumbCanvas.width, thumbCanvas.height);

        const pageId = fileId + '_img';
        const nodeData = {
          id: pageId,
          fileId,
          pageIndex: 0,
          rotation: 0,
          mirrorH: false,
          mirrorV: false,
          baseOrientation: nativeWidth > nativeHeight ? 'horizontal' : 'vertical',
          nativeWidth,
          nativeHeight,
          // Miniatura liviana SOLO para la tarjeta/vista previa inicial — el
          // PDF final y el zoom en el modal siempre usan el archivo ORIGINAL
          // guardado en imageDocumentsData, nunca esta versión recomprimida.
          thumb: thumbCanvas.toDataURL('image/jpeg', 0.72),
          isWord: false,
          isImage: true
        };
        pageRegistry.push(nodeData);
        createCardInDOM(nodeData);
        thumbCanvas.width = 0;
      } catch (e) {
        console.error('Error al procesar imagen ' + file.name, e);
        showToast('No se pudo procesar la imagen "' + file.name + '".', 'error');
        createFailedCard(fileId, 0, file.name.slice(0, 14));
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    }

    /* ═══════════════════════════════════════════════
       PROCESAR ARCHIVOS (PDF + DOCX + PNG/JPG)
       ═══════════════════════════════════════════════ */
    async function processFiles(files) {
      const allFiles = Array.from(files);
      const pdfs   = allFiles.filter(f => f.type === 'application/pdf'  || f.name.toLowerCase().endsWith('.pdf'));
      const docxs  = allFiles.filter(f => f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || f.name.toLowerCase().endsWith('.docx'));
      const images = allFiles.filter(f =>
        /^image\/(png|jpeg|webp|gif|tiff)$/.test(f.type) || /\.(png|jpe?g|webp|gif|tiff?)$/i.test(f.name)
      );

      // El .doc "clásico" (Word 97-2003) es un formato binario totalmente
      // distinto al .docx (que es un .zip por dentro) — no hay forma
      // confiable de leerlo en el navegador con las librerías que usa esta
      // app. En vez de rechazarlo en silencio ("no admite" sin más
      // explicación), se detecta puntualmente y se le dice al usuario
      // exactamente qué hacer.
      const legacyDocs = allFiles.filter(f => /\.doc$/i.test(f.name));
      if (legacyDocs.length > 0) {
        const nombres = legacyDocs.map(f => '"' + f.name + '"').join(', ');
        showToast(
          'Word 97-2003 (.doc) no es compatible: ' + nombres + '. Ábrelo en Word/LibreOffice/Google Docs y usa "Guardar como" → .docx, luego vuelve a intentarlo.',
          'error'
        );
      }

      if (pdfs.length === 0 && docxs.length === 0 && images.length === 0) {
        if (legacyDocs.length === 0) {
          showToast('Solo se aceptan PDF, DOCX, o imágenes PNG/JPG/WEBP/GIF.', 'warning');
        }
        return;
      }

      // Fix #7: aviso (no bloqueante) si el lote es muy pesado en bytes
      const totalBytes = allFiles.reduce((acc, f) => acc + f.size, 0);
      if (totalBytes > MAX_TOTAL_BYTES) {
        showToast('El lote pesa más de ' + Math.round(MAX_TOTAL_BYTES / (1024 * 1024)) + 'MB. El navegador podría ir lento.', 'warning');
      }

      if (pageRegistry.length >= MAX_TOTAL_PAGES) {
        showToast('Ya alcanzaste el límite de ' + MAX_TOTAL_PAGES + ' páginas en el workspace.', 'error');
        return;
      }

      showLoader('Procesando archivos...', true);
      btnGenerate.disabled = true;
      const totalFiles = pdfs.length + docxs.length + images.length;
      let processed = 0;

      for (const file of pdfs) {
        const fileId = generateId();
        const buffer = await file.arrayBuffer();
        pdfDocumentsData.set(fileId, { buffer, name: file.name });
        await processPDF(file, fileId, buffer);
        const newIds = pageRegistry.filter(r => r.fileId === fileId && !r.isFailed).map(r => r.id);
        if (newIds.length > 1 && askKeepAsBlock(file.name, newIds.length)) {
          wrapCardsIntoGroup(newIds, file.name);
        }
        processed++;
        updateProgress(processed, totalFiles);
      }

      for (const file of docxs) {
        const fileId = generateId();
        const buffer = await file.arrayBuffer();
        wordDocumentsData.set(fileId, { buffer, name: file.name });
        await processWord(file, fileId, buffer);
        const newIds = pageRegistry.filter(r => r.fileId === fileId && !r.isFailed).map(r => r.id);
        if (newIds.length > 1 && askKeepAsBlock(file.name, newIds.length)) {
          wrapCardsIntoGroup(newIds, file.name);
        }
        processed++;
        updateProgress(processed, totalFiles);
      }

      for (const file of images) {
        const fileId = generateId();
        const buffer = await file.arrayBuffer();
        const kind = detectImageType(buffer);
        if (!kind) {
          showToast('El archivo "' + file.name + '" no es una imagen PNG/JPG/WEBP/GIF válida.', 'error');
          processed++;
          updateProgress(processed, totalFiles);
          continue;
        }
        // TIFF: ningún navegador lo decodifica de forma nativa (a
        // diferencia de WEBP/GIF, que sí) — no hay forma confiable de
        // procesarlo aquí. Mismo trato que ".doc": rechazo explícito con
        // instrucción concreta, en vez de un fallo silencioso o genérico.
        if (kind === 'tiff') {
          showToast(
            'TIFF no es compatible: "' + file.name + '". Ábrela en cualquier editor de imágenes y "Guardar como" → PNG o JPG, luego vuelve a intentarlo.',
            'error'
          );
          processed++;
          updateProgress(processed, totalFiles);
          continue;
        }
        const mimeByKind = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
        imageDocumentsData.set(fileId, { buffer, name: file.name, mimeType: mimeByKind[kind] });
        await processImage(file, fileId, buffer, kind);
        processed++;
        updateProgress(processed, totalFiles);
      }

      btnGenerate.disabled = (pageRegistry.length === 0);
      hideLoader();
      fileInput.value = '';

      if (pageRegistry.length > 0) {
        showToast('Cargadas ' + pageRegistry.length + ' páginas. Organízalas y genera el PDF.', 'success');
        flashPageCountBadge();
      }
    }

    /* ═══════════════════════════════════════════════
       GEOMETRÍA: desplazamiento de pivote por rotación
       (deriva de cómo un /Rotate clockwise reubica las
       esquinas de la hoja; usado para "hornear" la
       rotación directamente en el contenido, en vez de
       usar el flag /Rotate de la página — así el foleo
       puede dibujarse SIEMPRE en el mismo punto fijo).
       ═══════════════════════════════════════════════ */
    function getRotateOffset(rot, contentW, contentH) {
      if (rot === 90)  return { x: 0, y: contentW };
      if (rot === 180) return { x: contentW, y: contentH };
      if (rot === 270) return { x: contentH, y: 0 };
      return { x: 0, y: 0 };
    }

    /* Rota (clockwise, igual convención que rot) un vector (a,b) */
    function rotateVector(a, b, rot) {
      if (rot === 90)  return { x: b, y: -a };
      if (rot === 180) return { x: -a, y: -b };
      if (rot === 270) return { x: -b, y: a };
      return { x: a, y: b };
    }

    /*
      Dibuja `drawable` (imagen o página incrustada) sobre `page`, ya rotado
      y espejado (combinables — Requerimiento #2), horneando la transformación
      directamente en el contenido para que `page` NUNCA use /Rotate.
      Esto es lo que permite que el foleo se dibuje siempre en el mismo punto
      fijo (arriba-derecha) sin importar rot/mirror — Requerimiento #3.
    */
    function drawTransformedContent(page, drawFn, contentW, contentH, rot, mirrorH, mirrorV) {
      const rotateOffset = getRotateOffset(rot, contentW, contentH);

      // Offset adicional por espejo, calculado en el marco LOCAL (antes de
      // rotar) y luego rotado junto con el resto, para que espejo+rotación
      // combinados no se desalineen entre sí.
      const localMirrorOffsetX = mirrorH ? contentW : 0;
      const localMirrorOffsetY = mirrorV ? contentH : 0;
      const rotatedMirrorOffset = rotateVector(localMirrorOffsetX, localMirrorOffsetY, rot);

      const finalX = rotateOffset.x + rotatedMirrorOffset.x;
      const finalY = rotateOffset.y + rotatedMirrorOffset.y;

      // FIX (confirmado por prueba geométrica): pdf-lib rota en sentido
      // ANTIHORARIO para valores positivos (documentación oficial de pdf-lib).
      // Mis fórmulas de posición fueron derivadas para rotación física
      // HORARIA, así que se compensa invirtiendo el signo del ángulo.
      drawFn({
        x: finalX,
        y: finalY,
        width: mirrorH ? -contentW : contentW,
        height: mirrorV ? -contentH : contentH,
        rotate: PDFLib.degrees(-rot)
      });
    }

    /* Marca una hoja que no pudo incrustar su contenido real con un aviso
       visible e inconfundible, DENTRO del propio PDF (no solo en un toast
       de la sesión de generación). Un marco rojo + texto centrado que se
       ajusta al tamaño de la hoja: nadie que abra el documento después
       puede confundir esto con una página en blanco legítima. */
    function stampFailureNotice(page, font, rgbFn) {
      const { width, height } = page.getSize();
      const margin = Math.max(10, Math.min(width, height) * 0.02);

      page.drawRectangle({
        x: margin,
        y: margin,
        width: width - margin * 2,
        height: height - margin * 2,
        borderColor: rgbFn(0.86, 0.16, 0.16),
        borderWidth: Math.max(2, Math.min(width, height) * 0.006)
      });

      const msg = 'HOJA NO PROCESADA — VOLVER A INSERTAR ESTE DOCUMENTO';
      const size = Math.max(8, Math.min(15, width / 34));
      page.drawText(msg, {
        x: margin + 10,
        y: height / 2,
        size,
        font,
        color: rgbFn(0.75, 0.1, 0.1),
        maxWidth: Math.max(20, width - margin * 2 - 20),
        lineHeight: size * 1.3
      });
    }

    /* ═══════════════════════════════════════════════
       GENERAR PDF UNIFICADO
       ═══════════════════════════════════════════════ */
    btnGenerate.addEventListener('click', async () => {
      if (pageRegistry.length === 0 || isGenerating) return;

      isGenerating = true;
      const applyFoleo    = chkFoleo && chkFoleo.checked;
      const applyFoleoInv = chkFoleoInv && chkFoleoInv.checked;
      let folioNum         = parseInt((folioStart && folioStart.value) || 1) || 1;

      showLoader('Compilando documento final...', true);

      try {
        const { PDFDocument, StandardFonts, rgb, degrees } = PDFLib;
        const finalPdf   = await PDFDocument.create();
        const loadedSrcDocs = new Map();
        // Fix de rendimiento: getPages() se calcula UNA sola vez por archivo
        // aquí, en vez de dentro del bucle por página (donde antes se repetía
        // una vez por cada página del documento final — un costo que crecía
        // en O(n²) y se volvía notoriamente inestable pasado ~150-200 páginas).
        const srcPagesCache = new Map();

        for (const [fileId, entry] of pdfDocumentsData.entries()) {
          try {
            const doc = await PDFDocument.load(entry.buffer, { ignoreEncryption: true });
            loadedSrcDocs.set(fileId, doc);
            srcPagesCache.set(fileId, doc.getPages());
          } catch (e) {
            console.error('Error al cargar ' + entry.name, e);
          }
        }

        const font = await finalPdf.embedFont(StandardFonts.HelveticaBold);

        const BASE_W = 595.28, BASE_H = 841.89; // A4 en puntos
        // Se registra el NÚMERO de cada hoja que falla (no solo cuántas), para
        // que el usuario sepa exactamente cuáles revisar en un lote grande.
        const failedPageNumbers = [];

        // ═══ PASADA 1: construir cada hoja del PDF final ═══
        // Se separa "construir la hoja" de "estampar el foleo" (pasada 2,
        // más abajo). Antes ambas cosas pasaban juntas en un solo bucle, así
        // que una hoja que terminaba en blanco por un fallo de inserción
        // igual recibía su número de foleo — el bug reportado de "páginas
        // en blanco foleadas". Ahora cada hoja queda marcada con `success`
        // (tuvo contenido real) o no, y solo las exitosas se folean; las
        // fallidas ni gastan número ni se estampan.
        const pageResults = [];

        for (let i = 0; i < pageRegistry.length; i++) {
          updateProgress(i, pageRegistry.length);
          if (i % 10 === 0) await new Promise(r => setTimeout(r, 1));

          const req = pageRegistry[i];
          if (req.isFailed) continue;

          const rot   = req.rotation || 0;
          const mH    = !!req.mirrorH;
          const mV    = !!req.mirrorV;
          const swapDims = (rot === 90 || rot === 270);

          let newPage;
          let success = false;

          if (req.isWord) {
            if (!req.thumb || req.thumb.startsWith('data:image/svg')) {
              newPage = finalPdf.addPage(swapDims ? [BASE_H, BASE_W] : [BASE_W, BASE_H]);
              failedPageNumbers.push(finalPdf.getPageCount());
            } else {
              // Fix DEFINITIVO al reclamo recurrente de formato alterado:
              // la hoja del PDF final ahora se dimensiona con el tamaño
              // REAL de esa hoja de Word (req.nativeWidth/nativeHeight, leído
              // de w:pgSz por docx-preview) — ya no se fuerza un A4 con
              // márgenes inventados por esta app. Igual que ya hacían las
              // imágenes sueltas (rama de abajo), la captura de la hoja YA
              // incluye sus propios márgenes reales (padding calculado de
              // w:pgMar), así que se incrusta tal cual, sin componer nada.
              const pageW = swapDims ? req.nativeHeight : req.nativeWidth;
              const pageH = swapDims ? req.nativeWidth : req.nativeHeight;
              // La hoja se agrega UNA sola vez, antes de intentar dibujar
              // nada — así, si algo falla más abajo, queda en blanco pero
              // NUNCA se duplica agregando una segunda de rescate encima.
              newPage = finalPdf.addPage([pageW, pageH]);

              try {
                // Blindaje: hasta 2 intentos ante un fallo puntual de
                // incrustación (ej. una condición transitoria al decodificar
                // la imagen). Cada intento parte de cero, así que un intento
                // fallido nunca deja contenido a medias.
                //
                // FIX (causa histórica de "hojas Word en blanco"): un
                // enfoque anterior componía la imagen en una página de un
                // PDFDocument TEMPORAL y luego la incrustaba en finalPdf con
                // embedPage() — ese doble-incrustado no lanzaba ningún
                // error, pero pdf-lib no resolvía el recurso de imagen al
                // copiar la página entre documentos, dejando la hoja
                // técnicamente válida pero completamente en blanco. Por eso
                // aquí se incrusta directo con embedJpg + drawImage, el
                // mismo camino simple que ya usan las imágenes sueltas
                // (PNG/JPG) más abajo, confirmado sin ese problema.
                await retryAsync(async () => {
                  const imgBytes = await fetch(req.thumb).then(r => r.arrayBuffer());
                  const embeddedImage = await finalPdf.embedJpg(imgBytes);
                  drawTransformedContent(
                    newPage,
                    (opts) => newPage.drawImage(embeddedImage, opts),
                    req.nativeWidth, req.nativeHeight, rot, mH, mV
                  );
                }, 2, 250);
                success = true;
              } catch (e) {
                console.error('Error al insertar imagen Word:', e);
                failedPageNumbers.push(finalPdf.getPageCount());
                // newPage ya existe (agregada arriba) — queda en blanco,
                // sin agregar ninguna hoja adicional.
              }
            }
          } else if (req.isImage) {
            // La imagen conserva su propia proporción (a diferencia de
            // Word, que siempre fuerza A4): la hoja del PDF final se
            // dimensiona directamente a partir de nativeWidth/nativeHeight.
            const entry = imageDocumentsData.get(req.fileId);
            const pageW = swapDims ? req.nativeHeight : req.nativeWidth;
            const pageH = swapDims ? req.nativeWidth : req.nativeHeight;
            newPage = finalPdf.addPage([pageW, pageH]);

            if (entry) {
              try {
                await retryAsync(async () => {
                  const isJpeg = entry.mimeType === 'image/jpeg';
                  // .slice(0) clona el buffer: nunca se le pasa a pdf-lib la
                  // referencia directa guardada en imageDocumentsData, por si
                  // se necesita para un segundo intento o una regeneración.
                  const embeddedImage = isJpeg
                    ? await finalPdf.embedJpg(entry.buffer.slice(0))
                    : await finalPdf.embedPng(entry.buffer.slice(0));
                  drawTransformedContent(
                    newPage,
                    (opts) => newPage.drawImage(embeddedImage, opts),
                    req.nativeWidth, req.nativeHeight, rot, mH, mV
                  );
                }, 2, 250);
                success = true;
              } catch (e) {
                console.error('Error al incrustar imagen:', e);
                failedPageNumbers.push(finalPdf.getPageCount());
              }
            } else {
              failedPageNumbers.push(finalPdf.getPageCount());
            }
          } else {
            const srcDoc = loadedSrcDocs.get(req.fileId);
            if (!srcDoc) {
              newPage = finalPdf.addPage(swapDims ? [BASE_H, BASE_W] : [BASE_W, BASE_H]);
              failedPageNumbers.push(finalPdf.getPageCount());
            } else {
              let srcPage = null, srcW = BASE_W, srcH = BASE_H, intrinsicRot = 0;
              try {
                const srcPages = srcPagesCache.get(req.fileId);
                srcPage = srcPages[req.pageIndex];
                const size = srcPage.getSize();
                srcW = size.width;
                srcH = size.height;
              } catch (e) {
                console.error('Error al leer dimensiones de la página original:', e);
                // Aquí la hoja AÚN no se ha agregado (se agrega más abajo),
                // por eso su número final es el conteo actual + 1.
                failedPageNumbers.push(finalPdf.getPageCount() + 1);
                srcPage = null; // se usará el respaldo A4 más abajo
              }

              // Fix (hoja perdida por un detalle menor): antes, si SOLO la
              // lectura de /Rotate fallaba (con getSize() ya exitoso), se
              // descartaba la hoja COMPLETA y salía en blanco. La rotación
              // intrínseca es secundaria — si no se puede leer, se asume 0°
              // y se sigue igual con el contenido real de la página.
              if (srcPage) {
                try {
                  // CLAVE: pdf-lib IGNORA la marca interna /Rotate de la página
                  // (getSize devuelve siempre las dimensiones crudas del
                  // MediaBox), mientras que pdf.js —que genera las miniaturas
                  // que ve el usuario— SÍ la aplica. Ese desajuste hacía que
                  // las páginas escaneadas con /Rotate se vieran bien en
                  // pantalla pero salieran giradas en el PDF final. Aquí se
                  // lee esa marca para combinarla con la rotación del usuario.
                  const rawAngle = ((srcPage.getRotation().angle % 360) + 360) % 360;
                  // El estándar PDF exige múltiplos de 90, pero existen archivos
                  // mal formados. Un valor arbitrario (ej. 45) produciría
                  // geometría impredecible, así que se redondea al múltiplo de
                  // 90 más cercano en vez de propagar un valor inválido.
                  intrinsicRot = (Math.round(rawAngle / 90) * 90) % 360;
                } catch (e) {
                  console.warn('No se pudo leer la rotación intrínseca de la página; se asume 0°.', e);
                  intrinsicRot = 0;
                }
              }

              // Rotación total = la que ya traía la hoja + la que pidió el usuario.
              const totalRot = (intrinsicRot + rot) % 360;
              const totalSwap = (totalRot === 90 || totalRot === 270);
              const pageW = totalSwap ? srcH : srcW;
              const pageH = totalSwap ? srcW : srcH;

              // Fix adicional (confirmado por álgebra y prueba con marcador
              // asimétrico): cuando la rotación intrínseca de la hoja es de
              // 90°/270°, los ejes de espejo H/V que el usuario eligió —
              // mirando la vista YA orientada en pantalla— quedan CRUZADOS
              // si se aplican tal cual en el marco crudo de pdf-lib. Se
              // intercambian aquí antes de dibujar. (Con 0°/180° no hace
              // falta: esas rotaciones no cruzan los ejes de espejo.)
              const axesSwap = (intrinsicRot === 90 || intrinsicRot === 270);
              const finalMH = axesSwap ? mV : mH;
              const finalMV = axesSwap ? mH : mV;

              // Se agrega UNA sola vez antes del intento de dibujar, para
              // que un fallo posterior nunca duplique la hoja.
              newPage = finalPdf.addPage([pageW, pageH]);

              if (srcPage) {
                try {
                  // Blindaje: reintento único ante un fallo puntual de
                  // incrustación (embedPage internamente hace trabajo async).
                  await retryAsync(async () => {
                    const embedded = await finalPdf.embedPage(srcPage);
                    // embedPage entrega el contenido SIN aplicar /Rotate, así que
                    // se le pasan las dimensiones crudas y la rotación total.
                    drawTransformedContent(
                      newPage,
                      (opts) => newPage.drawPage(embedded, opts),
                      srcW, srcH, totalRot, finalMH, finalMV
                    );
                  }, 2, 250);
                  success = true;
                } catch (e) {
                  console.error('Error al incrustar página original:', e);
                  failedPageNumbers.push(finalPdf.getPageCount());
                }
              }
            }
          }

          pageResults.push({ newPage, success });
        }

        // ═══ Caso que NO debe existir en el producto final: una hoja en
        // blanco silenciosa, indistinguible de una página real ═══
        // Antes, una hoja que no pudo incrustar su contenido quedaba blanca
        // y punto — el único rastro del problema era un toast que el
        // usuario podía no ver o cerrar sin leer. Eso ya no es aceptable en
        // un documento oficial: cualquier hoja con success===false se marca
        // AHORA de forma explícita y permanente DENTRO del propio PDF, para
        // que sea imposible confundirla con una página en blanco legítima
        // al revisar el archivo — hoy, mañana, o quien sea que lo abra.
        pageResults.forEach(result => {
          if (!result.success) stampFailureNotice(result.newPage, font, rgb);
        });

        // ═══ PASADA 2: estampar el foleo — Requerimiento #3 ══
        // `newPage` NUNCA tiene /Rotate propio (la rotación ya está
        // horneada en el contenido arriba), así que el número SIEMPRE se
        // dibuja en el mismo punto fijo arriba-derecha, sin excepción. Solo
        // se estampan las hojas con `success === true`: una hoja en blanco
        // nunca gasta ni recibe número (Fix: "páginas en blanco foleadas").
        if (applyFoleo) {
          const stampablePages = pageResults.filter(r => r.success);

          // El total exacto de hojas foleables solo se conoce tras la
          // pasada 1 (antes se estimaba con pageRegistry.length, lo que
          // desalineaba el foleo inverso si alguna hoja terminaba en
          // blanco). Con el total real, la última hoja SIEMPRE cae en el
          // número de inicio elegido, sin importar cuántas hojas fallaron.
          if (applyFoleoInv) {
            folioNum = folioNum + stampablePages.length - 1;
          }

          for (const result of stampablePages) {
            const { width, height } = result.newPage.getSize();
            const fStr = String(folioNum).padStart(3, '0');

            // Fix: el sello del foleo se escala en proporción al tamaño real
            // de la hoja (referencia: A4). Antes usaba medidas fijas, lo que
            // lo dejaba diminuto e ilegible en hojas grandes (A3, planos) y
            // desproporcionado en hojas pequeñas.
            const scale = Math.max(0.6, Math.min(2.5, Math.min(width / BASE_W, height / BASE_H)));
            const fontSize = 11 * scale;
            const paddingX = 4 * scale;
            // El ancho del sello se mide contra el texto real, en vez de un
            // ancho fijo que antes podía cortar el texto.
            const textWidth = font.widthOfTextAtSize(fStr, fontSize);
            const boxW = Math.max(30 * scale, textWidth + paddingX * 2);
            const boxH = 16 * scale;
            const marginRight = 10 * scale, marginTop = 9 * scale;

            result.newPage.drawRectangle({
              x: width - boxW - marginRight,
              y: height - boxH - marginTop,
              width: boxW,
              height: boxH,
              color: rgb(1, 1, 1)
            });
            result.newPage.drawText(fStr, {
              x: width - boxW - marginRight + paddingX,
              y: height - boxH - marginTop + (4 * scale),
              size: fontSize, font,
              color: rgb(0, 0, 0)
            });

            if (applyFoleoInv) {
              folioNum--;
            } else {
              folioNum++;
            }
          }
        }

        // La compresión estructural (useObjectStreams) siempre queda activa:
        // no hay ningún caso real en que convenga desactivarla, así que ya
        // no se le pregunta al usuario (Fix: checkbox "Optimizar Peso" eliminado).
        const finalBytes = await finalPdf.save({ useObjectStreams: true });

        const blob = new Blob([finalBytes], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        revokedUrls.add(url);
        const link = document.createElement('a');
        link.href = url;
        link.download = resolveOutputFilename(); // Requerimiento #1
        link.click();

        setTimeout(() => {
          URL.revokeObjectURL(url);
          revokedUrls.delete(url);
        }, 3000);

        showToast('✅ PDF unificado generado exitosamente.', 'success');

        // Nunca más silencioso: si alguna hoja no pudo procesarse, se avisa
        // aquí Y ADEMÁS queda marcada de forma permanente dentro del propio
        // PDF (ver stampFailureNotice) — el aviso no depende de que el
        // usuario vea o recuerde este toast.
        if (failedPageNumbers.length > 0) {
          const lista = failedPageNumbers.slice(0, 15).join(', ') + (failedPageNumbers.length > 15 ? '…' : '');
          showToast('⚠️ ' + failedPageNumbers.length + ' hoja(s) no se procesaron y quedaron marcadas con un aviso en el PDF. Páginas: ' + lista, 'warning');
          console.warn('Hojas marcadas como no procesadas en el PDF final:', failedPageNumbers);
        }
      } catch (e) {
        console.error('Error en unificación:', e);
        showToast('Error crítico: ' + e.message, 'error');
      } finally {
        isGenerating = false;
        btnGenerate.disabled = (pageRegistry.length === 0);
        hideLoader();
      }
    });

    /* ═══════════════════════════════════════════════
       EVENTOS DROP ZONE / FILE INPUT
       ═══════════════════════════════════════════════ */
    dropZone.addEventListener('click', () => fileInput.click());

    ['dragover', 'dragenter'].forEach(ev => dropZone.addEventListener(ev, e => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    }));

    ['dragleave', 'drop'].forEach(ev => dropZone.addEventListener(ev, e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
    }));

    dropZone.addEventListener('drop', ev => processFiles(ev.dataTransfer.files));
    fileInput.addEventListener('change', ev => processFiles(ev.target.files));

    /* ═══════════════════════════════════════════════
       TECLAS: Supr / Ctrl+A / Escape / Ctrl+Z / Ctrl+Y
       ═══════════════════════════════════════════════ */
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

      // Ctrl+Z deshace; Ctrl+Y o Ctrl+Shift+Z rehace — cubre reordenar,
      // eliminar, rotar y espejar.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        redo();
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const selected = document.querySelectorAll('.page-card.selected');
        // Con más de 1 hoja, se pide confirmar — es la acción más
        // destructiva de la app y la más fácil de disparar sin querer
        // (por ejemplo, tras arrastrar/seleccionar varias por error).
        if (selected.length > 1 && !window.confirm('¿Eliminar ' + selected.length + ' hojas seleccionadas? Puedes deshacerlo después con Ctrl+Z.')) {
          return;
        }
        if (selected.length > 0) {
          withUndo(() => {
            selected.forEach(c => c.remove());
            syncRegistryWithDOM();
          });
          pruneUnreferencedFileData();
          updateSelectionUI();
          flashPageCountBadge();
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        // Las hojas agrupadas quedan fuera de Ctrl+A — se seleccionan y
        // borran a nivel de bloque, no una por una (ver ".in-group").
        document.querySelectorAll('.page-card:not(.in-group)').forEach(c => c.classList.add('selected'));
        updateSelectionUI();
      }

      if (e.key === 'Escape') {
        document.querySelectorAll('.page-card.selected').forEach(c => c.classList.remove('selected'));
        updateSelectionUI();
      }
    });

    /* ═══════════════════════════════════════════════
       FOLEO INVERSO: mostrar/ocultar
       ═══════════════════════════════════════════════ */
    if (chkFoleo && chkFoleoInv) {
      const invRow = document.getElementById('row-foleo-inverso');
      const syncFoleoRows = () => {
        const on = chkFoleo.checked ? '' : 'none';
        if (invRow) invRow.style.display = on;
        if (!chkFoleo.checked) chkFoleoInv.checked = false;
      };
      chkFoleo.addEventListener('change', syncFoleoRows);
      syncFoleoRows();
    }

    /* ═══════════════════════════════════════════════
       LIMPIEZA AL CERRAR
       ═══════════════════════════════════════════════ */
    window.addEventListener('beforeunload', (e) => {
      revokedUrls.forEach(url => URL.revokeObjectURL(url));
      revokedUrls.clear();

      // Avisa antes de cerrar/recargar si hay páginas cargadas sin exportar
      // — perder un lote organizado y foliado sin aviso sería el peor caso.
      if (pageRegistry.length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    console.log('✅ UNIFICADOR SEDAPAL — inicializado. PDF + DOCX + Imágenes + Multi-Drag + Rotación/Espejo/Zoom.');
  }
})();
