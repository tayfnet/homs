(()=>{
  /*
   * TAIF Currency display helpers.
   * Shared typography/fit helpers for read-only and transactional views, isolated from the management modal UI.
   */
  const TAIF = window.TAIF || (window.TAIF = {});
  const utils = TAIF.core && TAIF.core.utils ? TAIF.core.utils : {};
  const escapeHtml = typeof utils.escapeHtml === 'function' ? utils.escapeHtml : ((value) => String(value ?? ''));
  const display = TAIF.currencyDisplay || (TAIF.currencyDisplay = {});

  function createSingleLineHeaderLabel(text, { className = '', min = 9.8, max = 13.2, step = .2, minScale = .92 } = {}){
    return `<span class="taif-singleline-fit${className ? ` ${className}` : ''}" data-fit-min="${String(min)}" data-fit-max="${String(max)}" data-fit-step="${String(step)}" data-fit-min-scale="${String(minScale)}">${escapeHtml(text)}</span>`;
  }

  function mountSingleLineTextFit(root, selector, options = {}){
    if(!root || typeof root.querySelectorAll !== 'function' || !selector) return () => {};

    let rafId = 0;
    let disposed = false;
    let resizeObserver = null;

    const resolveTargets = () => Array.from(root.querySelectorAll(selector)).filter((node) => node && typeof node.getBoundingClientRect === 'function');

    const resetTarget = (node) => {
      if(!node) return;
      node.style.fontSize = '';
      node.style.transform = '';
      node.style.transformOrigin = '';
    };

    const fitTarget = (node) => {
      if(!node || !node.isConnected) return;

      const maxFontSize = Number(node.dataset.fitMax || options.maxFontSize || 0) || 12;
      const minFontSize = Number(node.dataset.fitMin || options.minFontSize || 0) || 8;
      const step = Math.max(.1, Number(node.dataset.fitStep || options.step || .2));
      const minScale = Math.min(1, Math.max(.82, Number(node.dataset.fitMinScale || options.minScale || .88)));

      resetTarget(node);
      node.style.fontSize = `${maxFontSize}px`;
      node.style.transformOrigin = 'center center';

      let nextFontSize = maxFontSize;
      while(nextFontSize > minFontSize && node.scrollWidth > (node.clientWidth + 1)){
        nextFontSize = Math.max(minFontSize, Number((nextFontSize - step).toFixed(2)));
        node.style.fontSize = `${nextFontSize}px`;
      }

      const availableWidth = node.clientWidth;
      const requiredWidth = node.scrollWidth;
      if(availableWidth > 0 && requiredWidth > (availableWidth + 1)){
        const scale = Math.max(minScale, availableWidth / requiredWidth);
        if(scale < .999){
          node.style.transform = `scale(${scale})`;
        }
      }
    };

    const applyFit = () => {
      if(disposed) return;
      resolveTargets().forEach(fitTarget);
    };

    const queueFit = () => {
      if(disposed) return;
      if(rafId) window.cancelAnimationFrame(rafId);
      rafId = window.requestAnimationFrame(() => {
        rafId = 0;
        applyFit();
      });
    };

    queueFit();

    if(typeof ResizeObserver === 'function'){
      resizeObserver = new ResizeObserver(() => {
        queueFit();
      });
      resizeObserver.observe(root);
      resolveTargets().forEach((node) => resizeObserver.observe(node));
    }

    window.addEventListener('resize', queueFit, { passive: true });

    return () => {
      disposed = true;
      if(rafId) window.cancelAnimationFrame(rafId);
      if(resizeObserver) resizeObserver.disconnect();
      window.removeEventListener('resize', queueFit);
      resolveTargets().forEach(resetTarget);
    };
  }

  display.createSingleLineHeaderLabel = createSingleLineHeaderLabel;
  display.mountSingleLineTextFit = mountSingleLineTextFit;

  const feature = TAIF.currencyManagementFeature || (TAIF.currencyManagementFeature = {});
  if(typeof feature.createSingleLineHeaderLabel !== 'function') feature.createSingleLineHeaderLabel = createSingleLineHeaderLabel;
  if(typeof feature.mountSingleLineTextFit !== 'function') feature.mountSingleLineTextFit = mountSingleLineTextFit;
})();
