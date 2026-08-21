/* ═══════════════════════════════════════════════════
   index.js — UNIFICADOR SEDAPAL (Fortificado v6)
   ✅ Multi-Drag manual de grupo
   ✅ Soporte Word/DOCX → hojas → workspace → PDF
   ✅ Foleo normal + inverso, SIEMPRE arriba-derecha
   ✅ Rotación (90°) + Espejo (horizontal/vertical) combinables
   ✅ Alcance de transformación: esta hoja / seleccionadas / todas
   ✅ Nombre de archivo personalizado
   ✅ Paginación Word real (ya no genera hojas en blanco)
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
    const HTML2CANVAS_OK = typeof html2canvas !== 'undefined';
    const MAMMOTH_OK     = typeof mammoth !== 'undefined';

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
    let pdfDocumentsData  = new Map();
    let wordDocumentsData = new Map();
    let pageRegistry      = [];
    let multiDragGroup    = null;
    let multiDragAnchor   = null;
    let autoSelectedByDrag = null;
    let isGenerating      = false;
    const revokedUrls     = new Set();
    const modalState      = { currentId: null, requestToken: 0 };
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
      Array.from(workspace.children).forEach(card => {
        const record = pageRegistry.find(p => p.id === card.dataset.id);
        if (record) newOrder.push(record);
      });
      pageRegistry = newOrder;
      btnGenerate.disabled = (pageRegistry.length === 0) || isGenerating;
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
        filter: '.card-tool, .btn-delete-page',
        preventOnFilter: true,

        onStart(evt) {
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

    function forceOrientation(desired) {
      const todasOn = chkTodas && chkTodas.checked;
      const idsToUse = todasOn
        ? pageRegistry.filter(p => !p.isFailed).map(p => p.id)
        : Array.from(document.querySelectorAll('.page-card.selected')).map(c => c.dataset.id);

      if (idsToUse.length === 0) {
        showToast('Selecciona al menos una hoja, o marca "Todas".', 'warning');
        return;
      }

      let changedCount = 0;
      idsToUse.forEach(id => {
        const record = pageRegistry.find(p => p.id === id);
        if (!record || record.isFailed) return;
        const current = effectiveOrientation(record);
        if (current === desired) return; // ya está bien, no se toca (idempotente)
        record.rotation = (record.rotation + 90) % 360;
        changedCount++;
        renderCardTransform(id);
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

    async function renderModalTransform() {
      const record = pageRegistry.find(p => p.id === modalState.currentId);
      if (!record || !modalImage) return;

      // Guarda contra clics rápidos de siguiente/anterior: si el usuario
      // navega de nuevo antes de que termine este render, la respuesta
      // vieja se descarta al llegar (nunca pisa la imagen correcta actual).
      const myToken = ++modalState.requestToken;
      const targetId = record.id;

      const sx = record.mirrorH ? -1 : 1;
      const sy = record.mirrorV ? -1 : 1;
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

      modalImage.style.transform = 'rotate(' + rot + 'deg) scale(' + sx + ',' + sy + ')';

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
          const applyAll = modalApplyAll && modalApplyAll.checked;
          const targetIds = applyAll
            ? getNavigablePages().map(p => p.id)
            : [modalState.currentId];
          applyTransform(modalState.currentId, btn.dataset.action, targetIds);
        });
      });
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
      card.dataset.id = data.id;
      card.dataset.fileId = data.fileId;
      card.dataset.pageIndex = data.pageIndex;
      card.setAttribute('tabindex', '0');
      card.setAttribute('role', 'listitem');

      card.addEventListener('click', (e) => {
        if (e.target.closest('.btn-delete-page') || e.target.closest('.card-tool')) return;
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
        if (isGroupDelete && !window.confirm('¿Eliminar ' + selected.length + ' hojas seleccionadas? Esta acción no se puede deshacer.')) {
          return;
        }
        if (selected.length > 0 && card.classList.contains('selected')) {
          selected.forEach(c => c.remove());
        } else {
          card.remove();
        }
        syncRegistryWithDOM();
        // Si la hoja borrada era la que se veía en el modal, se cierra sola
        // en vez de quedar mostrando una página que ya no existe.
        if (modalState.currentId && !pageRegistry.find(p => p.id === modalState.currentId)) {
          closeModal();
        }
        if (workspace.children.length === 0) {
          pdfDocumentsData.clear();
          wordDocumentsData.clear();
          revokedUrls.forEach(url => URL.revokeObjectURL(url));
          revokedUrls.clear();
          pageRegistry = [];
        }
        updateSelectionUI();
      });

      // Marco recortado + imagen miniatura
      const frame = document.createElement('div');
      frame.className = 'page-image-frame';

      const img = document.createElement('img');
      img.className = 'page-image';
      img.src = data.thumb;
      img.setAttribute('alt', data.isWord ? 'Hoja Word ' + (data.pageIndex + 1) : 'Página PDF ' + (data.pageIndex + 1));
      frame.appendChild(img);

      if (data.isWord) {
        const wordBadge = document.createElement('span');
        wordBadge.className = 'word-badge';
        wordBadge.textContent = 'W';
        card.appendChild(wordBadge);
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

    function createFailedCard(fileId, pageIdx, reason) {
      const id = fileId + '_failed_' + pageIdx;
      const card = document.createElement('div');
      card.className = 'page-card page-failed';
      card.dataset.id = id;
      card.dataset.fileId = fileId;
      card.dataset.pageIndex = pageIdx;

      const icon = document.createElement('div');
      icon.className = 'failed-icon';
      icon.textContent = '⚠️';

      const text = document.createElement('div');
      text.className = 'failed-text';
      text.textContent = reason || 'Error';

      card.appendChild(icon);
      card.appendChild(text);
      workspace.appendChild(card);

      pageRegistry.push({
        id,
        fileId,
        pageIndex: pageIdx,
        rotation: 0,
        mirrorH: false,
        mirrorV: false,
        thumb: null,
        isFailed: true
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

        for (let i = 1; i <= totalPages; i++) {
          // Fix #7: límite duro de páginas totales para proteger la memoria del navegador
          if (pageRegistry.length >= MAX_TOTAL_PAGES) {
            showToast('Se alcanzó el límite de ' + MAX_TOTAL_PAGES + ' páginas. El resto de "' + file.name + '" no se cargó.', 'warning');
            break;
          }

          updateProgress(i, totalPages);
          if (i % 5 === 0) await new Promise(r => setTimeout(r, 1));

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
       DIVIDIR CONTENIDO WORD EN PÁGINAS REALES (Fix #1)
       Reemplaza el antiguo fallback que empujaba números
       enteros en vez de nodos, generando hojas en blanco.
       ═══════════════════════════════════════════════ */
    function splitBodyIntoPages(bodyEl, pageHeightPx) {
      const candidateNodes = Array.from(bodyEl.childNodes).filter(n =>
        n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim().length > 0)
      );

      if (candidateNodes.length === 0) return [];

      const pages = [];
      let current = [];
      let currentHeight = 0;

      candidateNodes.forEach(node => {
        const h = (node.nodeType === 1 && typeof node.offsetHeight === 'number')
          ? node.offsetHeight
          : 20; // estimación para nodos de texto sueltos

        if (currentHeight + h > pageHeightPx && current.length > 0) {
          pages.push(current);
          current = [];
          currentHeight = 0;
        }
        current.push(node);
        currentHeight += h;
      });

      if (current.length > 0) pages.push(current);
      return pages;
    }

    /* ═══════════════════════════════════════════════
       PROCESAR WORD (DOCX) → renderizar como imagen
       ═══════════════════════════════════════════════ */
    async function processWord(file, fileId, buffer) {
      if (!isValidDOCX(buffer)) {
        showToast('El archivo "' + file.name + '" no es un DOCX válido.', 'error');
        return;
      }
      if (!MAMMOTH_OK) {
        showToast('Librería mammoth.js no disponible. No se puede procesar Word.', 'error');
        return;
      }
      // Fix #4: si html2canvas no cargó, se aborta ANTES de generar nada,
      // en vez de crear hojas en blanco silenciosas.
      if (!HTML2CANVAS_OK) {
        showToast('html2canvas no disponible: "' + file.name + '" no se procesó (se habría generado en blanco).', 'error');
        return;
      }

      try {
        const result = await mammoth.convertToHtml({ arrayBuffer: buffer });
        const html = result.value;
        if (!html || html.trim().length === 0) {
          showToast('El documento "' + file.name + '" está vacío.', 'warning');
          return;
        }

        const iframe = document.createElement('iframe');
        iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:794px;height:1123px;';
        iframe.sandbox = 'allow-same-origin';
        document.body.appendChild(iframe);

        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        iframeDoc.open();
        iframeDoc.write('<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
          'body{font-family:Arial,sans-serif;font-size:12pt;line-height:1.6;padding:50px 56px;width:794px;box-sizing:border-box;color:#333;}' +
          'table{border-collapse:collapse;width:100%;}td,th{border:1px solid #ccc;padding:6px;}' +
          'img{max-width:100%;height:auto;}' +
          '@page{size:A4;margin:0;}' +
          '.page-break{page-break-after:always;}' +
          '</style></head><body>' + html + '</body></html>');
        iframeDoc.close();

        await new Promise(r => setTimeout(r, 500));

        const body = iframeDoc.body;
        const pageHeight = 1123; // px equivalentes a A4

        const pageBreaks = body.querySelectorAll('.page-break, [style*="page-break-after"], hr[style*="page-break"]');

        let pages = [];
        if (pageBreaks.length > 0) {
          let currentPageContent = [];
          const allNodes = Array.from(body.childNodes);
          for (const node of allNodes) {
            const isBreak = (node.nodeType === 1 && (
              node.classList.contains('page-break') ||
              (node.style && node.style.pageBreakAfter === 'always')
            ));
            if (isBreak) {
              if (currentPageContent.length > 0) pages.push(currentPageContent);
              currentPageContent = [];
            } else if (node.nodeType === 1 || (node.nodeType === 3 && node.textContent.trim())) {
              currentPageContent.push(node);
            }
          }
          if (currentPageContent.length > 0) pages.push(currentPageContent);
        } else {
          // Fix #1: división real por altura acumulada de nodos, ya NO por
          // números de página vacíos. Cada elemento de "pages" es ahora
          // siempre un array de nodos reales del documento.
          pages = splitBodyIntoPages(body, pageHeight);
        }

        if (pages.length === 0) {
          showToast('No se pudo determinar contenido paginable en "' + file.name + '".', 'warning');
          document.body.removeChild(iframe);
          return;
        }

        for (let p = 0; p < pages.length; p++) {
          if (pageRegistry.length >= MAX_TOTAL_PAGES) {
            showToast('Se alcanzó el límite de ' + MAX_TOTAL_PAGES + ' páginas. El resto de "' + file.name + '" no se cargó.', 'warning');
            break;
          }
          updateProgress(p + 1, pages.length);

          const tempDiv = document.createElement('div');
          tempDiv.style.cssText = 'width:794px;padding:50px 56px;box-sizing:border-box;background:#fff;font-family:Arial,sans-serif;font-size:12pt;line-height:1.6;color:#333;';
          pages[p].forEach(node => tempDiv.appendChild(node.cloneNode(true)));
          document.body.appendChild(tempDiv);

          try {
            // Fix #2: resolución subida de 0.3 a 2 para que el foliado y la
            // impresión de documentos oficiales no salgan borrosos.
            const canvas = await html2canvas(tempDiv, { scale: 2, useCORS: true, logging: false, width: 794 });
            const pageId = fileId + '_w_' + (p + 1);
            const nodeData = {
              id: pageId,
              fileId,
              pageIndex: p,
              rotation: 0,
              mirrorH: false,
              mirrorV: false,
              baseOrientation: canvas.width > canvas.height ? 'horizontal' : 'vertical',
              nativeWidth: canvas.width,
              nativeHeight: canvas.height,
              thumb: canvas.toDataURL('image/jpeg', 0.75),
              isWord: true
            };
            pageRegistry.push(nodeData);
            createCardInDOM(nodeData);
            canvas.width = 0;
          } catch (e) {
            createFailedCard(fileId, p, 'Word pág ' + (p + 1));
          }
          document.body.removeChild(tempDiv);
        }

        document.body.removeChild(iframe);
      } catch (err) {
        console.error('Error Word:', err);
        showToast('Error al procesar: ' + file.name, 'error');
      }
    }

    /* ═══════════════════════════════════════════════
       PROCESAR ARCHIVOS (PDF + DOCX)
       ═══════════════════════════════════════════════ */
    async function processFiles(files) {
      const allFiles = Array.from(files);
      const pdfs  = allFiles.filter(f => f.type === 'application/pdf'  || f.name.toLowerCase().endsWith('.pdf'));
      const docxs = allFiles.filter(f => f.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || f.name.toLowerCase().endsWith('.docx'));

      if (pdfs.length === 0 && docxs.length === 0) {
        showToast('Solo se aceptan PDF y DOCX.', 'warning');
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
      const totalFiles = pdfs.length + docxs.length;
      let processed = 0;

      for (const file of pdfs) {
        const fileId = generateId();
        const buffer = await file.arrayBuffer();
        pdfDocumentsData.set(fileId, { buffer, name: file.name });
        await processPDF(file, fileId, buffer);
        processed++;
        updateProgress(processed, totalFiles);
      }

      for (const file of docxs) {
        const fileId = generateId();
        const buffer = await file.arrayBuffer();
        wordDocumentsData.set(fileId, { buffer, name: file.name });
        await processWord(file, fileId, buffer);
        processed++;
        updateProgress(processed, totalFiles);
      }

      btnGenerate.disabled = (pageRegistry.length === 0);
      hideLoader();
      fileInput.value = '';

      if (pageRegistry.length > 0) {
        showToast('Cargadas ' + pageRegistry.length + ' páginas. Organízalas y genera el PDF.', 'success');
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

        // Fix #3 (bug de foleo inverso): el conteo para el número inicial
        // debe excluir páginas fallidas, igual que el loop que las salta.
        const validPages = pageRegistry.filter(p => !p.isFailed);
        if (applyFoleo && applyFoleoInv) {
          folioNum = folioNum + validPages.length - 1;
        }

        const BASE_W = 595.28, BASE_H = 841.89; // A4 en puntos
        let failedRenderCount = 0; // páginas que terminaron en blanco por algún error (ya nunca es silencioso)

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

          if (req.isWord) {
            if (!req.thumb || req.thumb.startsWith('data:image/svg')) {
              newPage = finalPdf.addPage(swapDims ? [BASE_H, BASE_W] : [BASE_W, BASE_H]);
            } else {
              const pageW = swapDims ? BASE_H : BASE_W;
              const pageH = swapDims ? BASE_W : BASE_H;
              // La hoja se agrega UNA sola vez, antes de intentar dibujar
              // nada — así, si algo falla más abajo, queda en blanco pero
              // NUNCA se duplica agregando una segunda de rescate encima.
              newPage = finalPdf.addPage([pageW, pageH]);

              try {
                const imgBytes = await fetch(req.thumb).then(r => r.arrayBuffer());
                const isJpeg = (req.thumb.startsWith('data:image/jpeg') || req.thumb.startsWith('data:image/jpg'));

                // Documento temporal INDEPENDIENTE, nunca agregado a
                // finalPdf: se arma ahí la página canónica y se descarta
                // sola al terminar. Ya no depende de agregar-y-luego-quitar
                // una página del PDF final (ese truco es lo que fallaba a
                // gran escala si removePage/getPageCount no coincidían).
                const tempDoc = await PDFDocument.create();
                const tempImage = isJpeg ? await tempDoc.embedJpg(imgBytes) : await tempDoc.embedPng(imgBytes);
                const dims = tempImage.scaleToFit(BASE_W - 80, BASE_H - 100);
                const marginX = (BASE_W - dims.width) / 2;
                const marginY = (BASE_H - dims.height) / 2;

                const canonicalPage = tempDoc.addPage([BASE_W, BASE_H]);
                canonicalPage.drawImage(tempImage, {
                  x: marginX, y: marginY,
                  width: dims.width, height: dims.height
                });

                const embeddedCanonical = await finalPdf.embedPage(canonicalPage);
                drawTransformedContent(
                  newPage,
                  (opts) => newPage.drawPage(embeddedCanonical, opts),
                  BASE_W, BASE_H, rot, mH, mV
                );
              } catch (e) {
                console.error('Error al insertar imagen Word:', e);
                failedRenderCount++;
                // newPage ya existe (agregada arriba) — queda en blanco,
                // sin agregar ninguna hoja adicional.
              }
            }
          } else {
            const srcDoc = loadedSrcDocs.get(req.fileId);
            if (!srcDoc) {
              newPage = finalPdf.addPage(swapDims ? [BASE_H, BASE_W] : [BASE_W, BASE_H]);
            } else {
              let srcPage = null, srcW = BASE_W, srcH = BASE_H, intrinsicRot = 0;
              try {
                const srcPages = srcPagesCache.get(req.fileId);
                srcPage = srcPages[req.pageIndex];
                const size = srcPage.getSize();
                srcW = size.width;
                srcH = size.height;
                // CLAVE: pdf-lib IGNORA la marca interna /Rotate de la página
                // (getSize devuelve siempre las dimensiones crudas del
                // MediaBox), mientras que pdf.js —que genera las miniaturas
                // que ve el usuario— SÍ la aplica. Ese desajuste hacía que
                // las páginas escaneadas con /Rotate se vieran bien en
                // pantalla pero salieran giradas en el PDF final. Aquí se
                // lee esa marca para combinarla con la rotación del usuario.
                intrinsicRot = ((srcPage.getRotation().angle % 360) + 360) % 360;
              } catch (e) {
                console.error('Error al leer dimensiones/rotación de la página original:', e);
                failedRenderCount++;
                srcPage = null; // se usará el respaldo A4 más abajo
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
                  const embedded = await finalPdf.embedPage(srcPage);
                  // embedPage entrega el contenido SIN aplicar /Rotate, así que
                  // se le pasan las dimensiones crudas y la rotación total.
                  drawTransformedContent(
                    newPage,
                    (opts) => newPage.drawPage(embedded, opts),
                    srcW, srcH, totalRot, mH, mV
                  );
                } catch (e) {
                  console.error('Error al incrustar página original:', e);
                  failedRenderCount++;
                }
              }
            }
          }

          // ── FOLEO — Requerimiento #3 ──
          // `newPage` NUNCA tiene /Rotate propio (la rotación ya está
          // horneada en el contenido arriba), así que el número SIEMPRE
          // se dibuja en el mismo punto fijo arriba-derecha, sin excepción.
          if (applyFoleo) {
            const { width, height } = newPage.getSize();
            const fStr = String(folioNum).padStart(3, '0');

            newPage.drawRectangle({
              x: width - 40, y: height - 25,
              width: 30, height: 16,
              color: rgb(1, 1, 1)
            });
            newPage.drawText(fStr, {
              x: width - 36, y: height - 21,
              size: 11, font,
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

        // Nunca más silencioso: si alguna hoja terminó en blanco por un
        // error puntual durante la generación, se avisa explícitamente
        // con el conteo exacto, en vez de que el usuario lo descubra solo
        // al abrir el archivo y ver páginas vacías sin explicación.
        if (failedRenderCount > 0) {
          showToast('⚠️ ' + failedRenderCount + ' hoja(s) no pudieron dibujarse y quedaron en blanco en el PDF final. Revisa la consola para más detalle.', 'warning');
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
       TECLAS: Supr / Ctrl+A / Escape
       ═══════════════════════════════════════════════ */
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        const selected = document.querySelectorAll('.page-card.selected');
        // Con más de 1 hoja, se pide confirmar — es la acción más
        // destructiva de la app y la más fácil de disparar sin querer
        // (por ejemplo, tras arrastrar/seleccionar varias por error).
        if (selected.length > 1 && !window.confirm('¿Eliminar ' + selected.length + ' hojas seleccionadas? Esta acción no se puede deshacer.')) {
          return;
        }
        if (selected.length > 0) {
          selected.forEach(c => c.remove());
          syncRegistryWithDOM();
          if (workspace.children.length === 0) {
            pdfDocumentsData.clear();
            wordDocumentsData.clear();
          }
          updateSelectionUI();
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        document.querySelectorAll('.page-card').forEach(c => c.classList.add('selected'));
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
      chkFoleo.addEventListener('change', () => {
        if (invRow) invRow.style.display = chkFoleo.checked ? '' : 'none';
        if (!chkFoleo.checked) chkFoleoInv.checked = false;
      });
      if (invRow) invRow.style.display = chkFoleo.checked ? '' : 'none';
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

    console.log('✅ UNIFICADOR SEDAPAL — inicializado. PDF + DOCX + Multi-Drag + Rotación/Espejo.');
  }
})();
