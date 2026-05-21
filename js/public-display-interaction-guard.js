(()=>{
  const root = window;
  const doc = document;
  const html = doc.documentElement;

  if(doc.__TAIF_PUBLIC_DISPLAY_INTERACTION_GUARD_BOUND__) return;
  doc.__TAIF_PUBLIC_DISPLAY_INTERACTION_GUARD_BOUND__ = true;

  html.classList.add('taif-public-display-guard-enabled');

  const EDITABLE_SELECTOR = [
    'input',
    'textarea',
    'select',
    'option',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]'
  ].join(',');

  function isEditableTarget(target){
    if(!target || target === doc || target === root) return false;
    const element = target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement;
    return Boolean(element && element.closest && element.closest(EDITABLE_SELECTOR));
  }

  function clearSelection(){
    const selection = typeof root.getSelection === 'function' ? root.getSelection() : null;
    if(selection && selection.rangeCount){
      try{ selection.removeAllRanges(); }catch{}
    }
  }

  function preventDisplayTextAction(event){
    if(isEditableTarget(event.target)) return;
    event.preventDefault();
    clearSelection();
  }

  function preventCopyKeys(event){
    if(isEditableTarget(event.target)) return;
    const key = String(event.key || '').toLowerCase();
    const blocked = (event.ctrlKey || event.metaKey) && ['a','c','x','s'].includes(key);
    if(!blocked) return;
    event.preventDefault();
    event.stopPropagation();
    clearSelection();
  }

  function fullscreenElement(){
    return doc.fullscreenElement || doc.webkitFullscreenElement || doc.msFullscreenElement || null;
  }

  function requestFullscreen(element){
    const request = element.requestFullscreen || element.webkitRequestFullscreen || element.msRequestFullscreen;
    if(typeof request !== 'function') return Promise.resolve(false);
    try{
      const result = request.call(element);
      return result && typeof result.then === 'function' ? result : Promise.resolve(true);
    }catch(error){
      return Promise.reject(error);
    }
  }

  function exitFullscreen(){
    const exit = doc.exitFullscreen || doc.webkitExitFullscreen || doc.msExitFullscreen;
    if(typeof exit !== 'function') return Promise.resolve(false);
    try{
      const result = exit.call(doc);
      return result && typeof result.then === 'function' ? result : Promise.resolve(true);
    }catch(error){
      return Promise.reject(error);
    }
  }

  function syncFullscreenClass(){
    html.classList.toggle('taif-public-display-is-fullscreen', Boolean(fullscreenElement()));
  }

  let fullscreenToggleLocked = false;
  async function toggleFullscreen(){
    if(fullscreenToggleLocked) return;
    fullscreenToggleLocked = true;
    clearSelection();
    try{
      if(fullscreenElement()){
        await exitFullscreen();
      }else{
        await requestFullscreen(html);
      }
    }catch(error){
      console.warn('[TAIF public display] fullscreen toggle blocked by browser', error);
    }finally{
      syncFullscreenClass();
      root.setTimeout(() => { fullscreenToggleLocked = false; }, 160);
    }
  }

  function handleDoubleClick(event){
    if(isEditableTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    toggleFullscreen();
  }

  let lastTouchTap = { time:0, x:0, y:0 };
  function handleTouchDoubleTap(event){
    if(isEditableTarget(event.target)) return;
    if(event.pointerType !== 'touch' && event.pointerType !== 'pen') return;

    const now = Date.now();
    const x = Number(event.clientX || 0);
    const y = Number(event.clientY || 0);
    const dx = Math.abs(x - lastTouchTap.x);
    const dy = Math.abs(y - lastTouchTap.y);
    const isSecondTap = now - lastTouchTap.time <= 420 && dx <= 34 && dy <= 34;

    if(isSecondTap){
      event.preventDefault();
      event.stopPropagation();
      lastTouchTap = { time:0, x:0, y:0 };
      toggleFullscreen();
      return;
    }

    lastTouchTap = { time:now, x, y };
  }

  doc.addEventListener('selectstart', preventDisplayTextAction, true);
  doc.addEventListener('dragstart', preventDisplayTextAction, true);
  doc.addEventListener('copy', preventDisplayTextAction, true);
  doc.addEventListener('cut', preventDisplayTextAction, true);
  doc.addEventListener('beforecopy', preventDisplayTextAction, true);
  doc.addEventListener('beforecut', preventDisplayTextAction, true);
  doc.addEventListener('contextmenu', preventDisplayTextAction, true);
  doc.addEventListener('keydown', preventCopyKeys, true);
  doc.addEventListener('pointerdown', (event) => {
    if(!isEditableTarget(event.target) && !isEditableTarget(doc.activeElement)) clearSelection();
  }, true);
  doc.addEventListener('selectionchange', () => { if(!isEditableTarget(doc.activeElement)) clearSelection(); });
  doc.addEventListener('dblclick', handleDoubleClick, true);
  doc.addEventListener('pointerup', handleTouchDoubleTap, true);
  doc.addEventListener('fullscreenchange', syncFullscreenClass);
  doc.addEventListener('webkitfullscreenchange', syncFullscreenClass);
  doc.addEventListener('msfullscreenchange', syncFullscreenClass);
  syncFullscreenClass();
})();
