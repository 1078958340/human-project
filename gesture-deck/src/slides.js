import { $, icon, notify } from './ui.js';
import { sampleSlides } from './mock.js';

export function setupSlides() {
  const player = $('player');
  const stage = $('slide-stage');
  const empty = stage.firstElementChild.cloneNode(true);
  let deck = null;
  let index = 0;
  let opening = null;
  let paintId = 0;
  let renderTask = null;
  let pdfLibrary;
  let locked = false;
  let displayed = Promise.resolve(null);
  let deckChanged = () => {};
  let manualPage = () => {};

  function controls() {
    $('prev-slide').disabled = locked || !deck || index === 0;
    $('next-slide').disabled = locked || !deck || index === deck.count - 1;
    $('fullscreen').disabled = !deck || !document.fullscreenEnabled;
    $('slide-page').value = deck ? `${index + 1} / ${deck.count}` : '0 / 0';
    $('deck-name').textContent = deck?.name ?? '未导入';
    $('deck-name').title = $('deck-name').textContent;
  }

  async function paint() {
    const token = ++paintId;
    renderTask?.cancel();
    renderTask = null;
    if (!deck) {
      stage.replaceChildren(empty.cloneNode(true));
      return;
    }
    try {
      if (deck.kind === 'example') {
        const item = document.createElement('div');
        const [label, title, subtitle] = sampleSlides[index];
        item.className = 'demo-slide';
        item.innerHTML = `<b>${label}</b><strong>${title}</strong><p>${subtitle}</p>`;
        stage.replaceChildren(item);
        return true;
      }
      if (deck.kind === 'images') {
        const image = document.createElement('img');
        image.src = deck.images[index].url;
        image.alt = deck.images[index].name;
        stage.replaceChildren(image);
        try {
          await image.decode();
          return token === paintId;
        } catch {
          if (token === paintId) showError('这张图片无法在浏览器中打开。');
          return false;
        }
      }
      const page = await deck.pdf.getPage(index + 1);
      if (token !== paintId) return;
      const rect = stage.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const natural = page.getViewport({ scale: 1 });
      const scale = Math.min(rect.width / natural.width, rect.height / natural.height);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: scale * pixelRatio });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${viewport.width / pixelRatio}px`;
      canvas.style.height = `${viewport.height / pixelRatio}px`;
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `PDF 幻灯片第 ${index + 1} 页`);
      const task = page.render({ canvas, viewport });
      renderTask = task;
      await task.promise;
      if (token === paintId) {
        stage.replaceChildren(canvas);
        return true;
      }
    } catch (error) {
      if (token === paintId && error.name !== 'RenderingCancelledException') showError('这页 PDF 无法渲染。');
    }
  }

  function showPage() {
    const painted = paint();
    const token = paintId;
    displayed = painted.then(didPaint => didPaint && token === paintId ? new Promise(resolve => {
      // A second animation frame lets the browser paint the new page first.
      // Background tabs may never schedule a frame, so omit their timing.
      const deadline = setTimeout(() => resolve(null), 180);
      requestAnimationFrame(() => requestAnimationFrame(time => {
        clearTimeout(deadline);
        resolve(token === paintId && !document.hidden ? time : null);
      }));
    }) : null);
  }

  function showError(message) {
    const state = empty.cloneNode(true);
    state.querySelector('strong').textContent = message;
    state.querySelector('small').textContent = '可以切换到另一页，或重新导入文件。';
    stage.replaceChildren(state);
  }

  function activate(nextDeck) {
    renderTask?.cancel();
    const previous = deck;
    deck = nextDeck;
    index = 0;
    deckChanged();
    stage.replaceChildren();
    controls();
    showPage();
    previous?.task?.destroy().catch(() => {});
    previous?.images?.forEach(image => URL.revokeObjectURL(image.url));
    $('present-event').value = '暂无';
  }

  function loadExample() {
    opening?.task?.destroy().catch(() => {});
    opening = null;
    activate({ kind: 'example', name: '示例幻灯片', count: sampleSlides.length });
  }

  async function importDeck(files) {
    const request = {};
    opening?.task?.destroy().catch(() => {});
    opening = request;
    $('deck-name').textContent = '正在读取文件…';
    try {
      const pdfFile = files.length === 1 && (files[0].type === 'application/pdf' || /\.pdf$/i.test(files[0].name));
      if (pdfFile) {
        const file = files[0];
        const data = new Uint8Array(await file.arrayBuffer());
        pdfLibrary ??= loadPdfLibrary().catch(error => {
          pdfLibrary = undefined;
          throw error;
        });
        const pdfjs = await pdfLibrary;
        if (opening !== request) return;
        const assetBase = new URL(import.meta.env.BASE_URL + 'pdf-support/', location.href).href;
        request.task = pdfjs.getDocument({
          data,
          cMapUrl: assetBase + 'cmaps/', cMapPacked: true,
          standardFontDataUrl: assetBase + 'standard_fonts/',
          wasmUrl: assetBase + 'wasm/', iccUrl: assetBase + 'iccs/'
        });
        request.task.onPassword = () => {
          if (opening !== request) return;
          notify('该 PDF 已加密，请先导出不需要密码的副本。', true);
          request.task.destroy().catch(() => {});
          opening = null;
          controls();
        };
        const pdf = await request.task.promise;
        if (opening !== request) {
          await request.task.destroy();
          return;
        }
        activate({ kind: 'pdf', name: file.name, count: pdf.numPages, pdf, task: request.task });
      } else if (files.every(file => file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(file.name))) {
        const collator = new Intl.Collator('zh-CN', { numeric: true });
        const images = files.sort((a, b) => collator.compare(a.name, b.name)).map(file => ({
          name: file.name, url: URL.createObjectURL(file)
        }));
        activate({ kind: 'images', name: `${images.length} 张图片`, count: images.length, images });
      } else {
        notify('请选择一个 PDF 文件，或一组幻灯片图片。', true);
      }
    } catch (error) {
      if (opening === request) {
        request.task?.destroy().catch(() => {});
        notify(`导入失败。 ${error.message}`, true);
      }
    } finally {
      if (opening === request) {
        opening = null;
        controls();
      }
    }
  }

  function advance(delta, label) {
    if (!deck) return false;
    const next = index + delta;
    if (next < 0 || next >= deck.count) return false;
    index = next;
    controls();
    showPage();
    $('present-event').value = `${label} · 第 ${index + 1} 页`;
    return true;
  }

  function advanceManually(delta, input) {
    if (locked || !deck) return;
    const pageBefore = index + 1;
    const moved = advance(delta, input === 'keyboard' ? '键盘翻页' : '手动翻页');
    manualPage({
      input, actionId: delta > 0 ? 'next_page' : 'previous_page',
      pageBefore, pageAfter: index + 1, status: moved ? 'executed' : 'page_boundary', executedPerfMs: performance.now()
    });
  }

  $('example-slides').onclick = loadExample;
  $('choose-slides').onclick = () => $('slide-file').click();
  $('slide-file').onchange = event => {
    const files = Array.from(event.currentTarget.files);
    if (files.length) importDeck(files);
    event.currentTarget.value = '';
  };
  $('prev-slide').onclick = () => advanceManually(-1, 'button');
  $('next-slide').onclick = () => advanceManually(1, 'button');
  $('fullscreen').onclick = async () => {
    try {
      if (document.fullscreenElement === player) {
        await document.exitFullscreen();
      } else {
        await player.requestFullscreen();
        player.focus();
      }
    } catch {
      notify('当前浏览器未能进入全屏。', true);
    }
  };
  document.addEventListener('fullscreenchange', () => {
    $('fullscreen-label').textContent = document.fullscreenElement === player ? '退出全屏' : '全屏';
  });
  document.addEventListener('keydown', event => {
    if ($('present').hidden || !deck || locked || event.defaultPrevented || event.repeat
      || event.altKey || event.ctrlKey || event.metaKey || event.target.closest?.('input, select, textarea, [contenteditable]')) return;
    if (event.key === ' ' && event.target.closest?.('button, a')) return;
    if (['ArrowLeft', 'ArrowRight', ' ', 'PageUp', 'PageDown'].includes(event.key)) {
      event.preventDefault();
      advanceManually(['ArrowLeft', 'PageUp'].includes(event.key) ? -1 : 1, 'keyboard');
    }
  });
  let resize;
  new ResizeObserver(() => {
    clearTimeout(resize);
    if (deck?.kind === 'pdf') resize = setTimeout(showPage, 75);
  }).observe(stage);

  return {
    loadExample, advance,
    hasDeck: () => Boolean(deck),
    deckInfo: () => ({ kind: deck.kind, name: deck.name, pageCount: deck.count,
      imageNames: deck.images?.map(image => image.name) }),
    page: () => deck ? index + 1 : null,
    whenDisplayed: () => displayed,
    onDeckChange(callback) { deckChanged = callback; },
    onManualPage(callback) { manualPage = callback; },
    lockManual(value) { locked = value; controls(); },
    rewind() {
      if (!deck) return;
      index = 0;
      controls();
      showPage();
    }
  };
}

async function loadPdfLibrary() {
  const [pdfjs, worker] = await Promise.all([
    import('pdfjs-dist/build/pdf.mjs'),
    import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  ]);
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs;
}
