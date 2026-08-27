/* ═══════════════════════════════════════════════════
   index.js — UNIFICADOR SEDAPAL (Ligero v9 — exclusivo PDF)
   ✅ Exclusivo PDF: sin Word ni imágenes — menos dependencias
      (fuera docx-preview/jszip/html2canvas), carga más rápida,
      motor mucho más simple
   ✅ Hasta ~2000 páginas por lote (antes 400)
   ✅ Foleo normal + inverso, SIEMPRE arriba-derecha, con
      total opcional
   ✅ Rotación (90°), con alcance de transformación: esta hoja /
      seleccionadas / todas
   ✅ Deshacer/Rehacer (Ctrl+Z / Ctrl+Y): reordenar, eliminar, rotar
   ✅ Zoom con doble clic + arrastre en la vista ampliada
   ✅ Rango de páginas al adjuntar un PDF grande, con vista previa real
   ✅ Bloque: trabajar un archivo completo como una sola unidad
   ✅ Nombre de archivo personalizado
   ✅ Generación en 2 pasadas: una hoja en blanco por fallo de
      inserción NUNCA gasta ni recibe número de foleo, y además
      queda marcada de forma explícita DENTRO del PDF final —
      "hoja en blanco silenciosa" es un caso que no existe
   ✅ Reintentos en inserciones PDF · Límite de memoria/páginas
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

    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';

    /* ── Límites de memoria / seguridad de ejecución ── */
    const MAX_TOTAL_PAGES  = 2000;                // páginas totales permitidas en el workspace
    const MAX_TOTAL_BYTES  = 500 * 1024 * 1024;   // 500MB de archivos cargados por lote

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
    let pdfDocumentsData  = new Map();
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
       Cubre reordenar, eliminar y rotar — cualquier acción que cambie el
       orden de pageRegistry o el rotation de una hoja. Cada entrada del
       historial guarda REFERENCIAS a los mismos objetos de pageRegistry (no
       copias de sus datos pesados como el thumb), así que deshacer una
       eliminación no necesita volver a leer el archivo original — el
       objeto de esa hoja nunca se destruyó, solo se sacó del array.
       ═══════════════════════════════════════════════ */
    const btnUndo = document.getElementById('btn-undo');
    const btnRedo = document.getElementById('btn-redo');
    let undoStack = [];
    let redoStack = [];
    const UNDO_CAP = 30;

    function snapshotRegistry() {
      return pageRegistry.map(r => ({ ref: r, rotation: r.rotation }));
    }

    function signatureOf(snapshot) {
      return snapshot.map(e => e.ref.id + ':' + e.rotation).join('|');
    }

    function updateUndoRedoUI() {
      if (btnUndo) btnUndo.disabled = undoStack.length === 0;
      if (btnRedo) btnRedo.disabled = redoStack.length === 0;
    }

    /* Envuelve cualquier acción que mute pageRegistry (reordenar, eliminar,
       rotar): guarda el estado ANTES de ejecutarla y, si algo realmente
       cambió, lo agrega al historial. Si la acción termina sin cambiar nada
       (ej. "Forzar Vertical" sobre hojas que ya estaban verticales), no se
       ensucia el historial con un paso inútil. */
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
       deshacer/rehacer — así vaciar el workspace y luego presionar Ctrl+Z
       nunca intenta regenerar el PDF a partir de un buffer que ya no existe. */
    function pruneUnreferencedFileData() {
      const live = new Set();
      pageRegistry.forEach(r => live.add(r.fileId));
      undoStack.forEach(snap => snap.forEach(e => live.add(e.ref.fileId)));
      redoStack.forEach(snap => snap.forEach(e => live.add(e.ref.fileId)));
      Array.from(pdfDocumentsData.keys()).forEach(key => { if (!live.has(key)) pdfDocumentsData.delete(key); });
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
        // herramientas de rotación o en el botón de eliminar.
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
       ROTACIÓN — Requerimiento #2
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

    /* Cuadro flotante con el total de páginas — visible unos segundos cada
       vez que cambia (al cargar y al eliminar hojas). */
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

    /* ── FORZAR VERTICAL / HORIZONTAL (acción absoluta e idempotente, no
       daña hojas que ya están en la orientación deseada — a diferencia de
       "rotar", que siempre suma 90° sin importar el estado actual) ── */
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

    /* Aplica la rotación visual (CSS) + la guarda en el registro de datos.
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

          switch (action) {
            case 'rotate-cw':
              record.rotation = (record.rotation + 90) % 360;
              break;
            case 'rotate-ccw':
              record.rotation = (record.rotation + 270) % 360;
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

    /* Refleja rotation en el <img> de la tarjeta (vista previa) */
    function renderCardTransform(id) {
      const record = pageRegistry.find(p => p.id === id);
      if (!record) return;
      const card = document.querySelector('[data-id="' + id + '"]');
      if (!card) return;
      const img = card.querySelector('.page-image');
      if (!img) return;

      img.style.transform = 'rotate(' + (record.rotation || 0) + 'deg)';

      // Indicador discreto de que la hoja tiene rotación activa
      let indicator = card.querySelector('.transform-indicator');
      if (record.rotation) {
        if (!indicator) {
          indicator = document.createElement('span');
          indicator.className = 'transform-indicator';
          card.appendChild(indicator);
        }
        indicator.textContent = record.rotation + '°';
      } else if (indicator) {
        indicator.remove();
      }
    }

    function buildCardToolsHTML() {
      return (
        '<div class="card-tools" role="group" aria-label="Rotar página">' +
          '<button type="button" class="card-tool" data-action="rotate-ccw" title="Rotar 90° a la izquierda" aria-label="Rotar 90° a la izquierda">' +
            '<svg viewBox="0 0 24 24"><path d="M4 9a8 8 0 1 1 1.5 8.5M4 9V4M4 9h5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '</button>' +
          '<button type="button" class="card-tool" data-action="rotate-cw" title="Rotar 90° a la derecha" aria-label="Rotar 90° a la derecha">' +
            '<svg viewBox="0 0 24 24"><path d="M20 9a8 8 0 1 0-1.5 8.5M20 9V4M20 9h-5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
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
       resolución de la página, renderizada directo del PDF fuente. */
    async function getHighResImage(record) {
      if (modalHighResCache.has(record.id)) return modalHighResCache.get(record.id);

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
       Compone la rotación (ya existente) con un escalado + desplazamiento
       de zoom. El translate va PRIMERO (en píxeles de pantalla) para que el
       arrastre se sienta natural sin importar cómo esté rotada la hoja. */
    function applyModalImageTransform(record) {
      if (!modalImage || !record) return;
      const rot = record.rotation || 0;
      const zoomScale = modalZoomState.zoomed ? MODAL_ZOOM_SCALE : 1;

      modalImage.style.transform =
        'translate(' + modalZoomState.tx + 'px,' + modalZoomState.ty + 'px) ' +
        'scale(' + zoomScale + ') ' +
        'rotate(' + rot + 'deg)';

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
      // puede arrastrar para reencuadrar.
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
    // mientras está en zoom.
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

      // Cada render (abrir, navegar, rotar) parte con el zoom reiniciado —
      // evita combinaciones raras de zoom heredado de una hoja distinta.
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
        // Ya no se limpia el buffer fuente de golpe al vaciar el workspace —
        // se libera solo lo que ya no referencia ni el workspace ni el
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
      img.setAttribute('alt', 'Página ' + (data.pageIndex + 1));
      frame.appendChild(img);

      // Herramientas de rotación (Requerimiento #2)
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
      toolsEl.setAttribute('aria-label', 'Rotar el bloque completo');
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
          // Límite duro de páginas totales para proteger la memoria del navegador
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
              baseOrientation: viewport.width > viewport.height ? 'horizontal' : 'vertical',
              // Proporción real de la hoja (la ratio es la misma a cualquier
              // escala, así que se reutiliza el viewport ya calculado sin
              // costo extra) — usada para dimensionar el marco del modal.
              nativeWidth: viewport.width,
              nativeHeight: viewport.height,
              thumb: canvas.toDataURL('image/jpeg', 0.5)
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

    /*
      Dibuja la página incrustada sobre `page`, ya rotada, horneando la
      transformación directamente en el contenido para que `page` NUNCA use
      /Rotate. Esto es lo que permite que el foleo se dibuje siempre en el
      mismo punto fijo (arriba-derecha) sin importar la rotación —
      Requerimiento #3.
    */
    function drawTransformedContent(page, drawFn, contentW, contentH, rot) {
      const offset = getRotateOffset(rot, contentW, contentH);

      // FIX (confirmado por prueba geométrica): pdf-lib rota en sentido
      // ANTIHORARIO para valores positivos (documentación oficial de pdf-lib).
      // Mis fórmulas de posición fueron derivadas para rotación física
      // HORARIA, así que se compensa invirtiendo el signo del ángulo.
      drawFn({
        x: offset.x,
        y: offset.y,
        width: contentW,
        height: contentH,
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
        const { PDFDocument, StandardFonts, rgb } = PDFLib;
        const finalPdf   = await PDFDocument.create();
        const loadedSrcDocs = new Map();
        // Fix de rendimiento: getPages() se calcula UNA sola vez por archivo
        // aquí, en vez de dentro del bucle por página (donde antes se repetía
        // una vez por cada página del documento final — un costo que crecía
        // en O(n²) y se volvía notoriamente inestable pasado ~150-200 páginas,
        // clave para poder sostener lotes de miles de páginas).
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

          const rot = req.rotation || 0;
          const swapDims = (rot === 90 || rot === 270);

          let newPage;
          let success = false;

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
                    srcW, srcH, totalRot
                  );
                }, 2, 250);
                success = true;
              } catch (e) {
                console.error('Error al incrustar página original:', e);
                failedPageNumbers.push(finalPdf.getPageCount());
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
            // 4 cifras (antes 3): con hasta ~2000 páginas por lote, un foleo
            // de 3 dígitos se quedaba corto (tope 999) antes de llegar al
            // final de un lote grande. El ancho del sello ya se mide contra
            // el texto real (ver abajo), así que el cambio no requiere tocar
            // nada más — un folio de 5+ cifras (inicio alto + lote grande)
            // tampoco se corta, solo deja de verse con ceros a la izquierda.
            const fStr = String(folioNum).padStart(4, '0');

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
        // no hay ningún caso real en que convenga desactivarla.
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
       PROCESAR ARCHIVOS (exclusivo PDF)
       ═══════════════════════════════════════════════ */
    async function processFiles(files) {
      const allFiles = Array.from(files);
      const pdfs = allFiles.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
      const rejected = allFiles.filter(f => pdfs.indexOf(f) === -1);

      if (rejected.length > 0) {
        const nombres = rejected.map(f => '"' + f.name + '"').join(', ');
        showToast('Esta app trabaja exclusivamente con PDF: ' + nombres + ' no se cargó.', 'warning');
      }

      if (pdfs.length === 0) return;

      // Aviso (no bloqueante) si el lote es muy pesado en bytes
      const totalBytes = pdfs.reduce((acc, f) => acc + f.size, 0);
      if (totalBytes > MAX_TOTAL_BYTES) {
        showToast('El lote pesa más de ' + Math.round(MAX_TOTAL_BYTES / (1024 * 1024)) + 'MB. El navegador podría ir lento.', 'warning');
      }

      if (pageRegistry.length >= MAX_TOTAL_PAGES) {
        showToast('Ya alcanzaste el límite de ' + MAX_TOTAL_PAGES + ' páginas en el workspace.', 'error');
        return;
      }

      showLoader('Procesando archivos...', true);
      btnGenerate.disabled = true;
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
        updateProgress(processed, pdfs.length);
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
      // eliminar y rotar.
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

    console.log('✅ UNIFICADOR SEDAPAL — inicializado. Exclusivo PDF · Rotación · Foleo · Bloques (hasta ' + MAX_TOTAL_PAGES + ' páginas).');
  }
})();
