(()=>{
  const root = window;
  const TAIF = root.TAIF || (root.TAIF = {});

  function taifDebugWarn(...args){
    const cfg = window.TAIF_PUBLIC_PRICE_CONFIG || {};
    if(cfg.DEBUG){
      console.warn(...args);
    }
  }
  const listeners = new Map();

  function clone(value){
    if(value === null || value === undefined) return value;
    if(typeof structuredClone === 'function'){
      try{ return structuredClone(value); }catch{}
    }
    try{ return JSON.parse(JSON.stringify(value)); }catch{ return value; }
  }

  function escapeHtml(value){
    return String(value ?? '')
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;')
      .replace(/'/g,'&#39;');
  }

  function runCleanupSlot(target, key){
    if(!target || !key) return;
    const cleanup = target[key];
    target[key] = null;
    if(typeof cleanup === 'function'){
      try{ cleanup(); }catch(error){ taifDebugWarn('[TAIF public display] cleanup failed', error); }
    }
  }

  function runCleanupCallbacks(callbacks){
    if(!Array.isArray(callbacks)) return;
    callbacks.splice(0).forEach((callback) => {
      if(typeof callback === 'function'){
        try{ callback(); }catch(error){ taifDebugWarn('[TAIF public display] cleanup callback failed', error); }
      }
    });
  }

  function wrapControlTextMarkup(content, extraClass = ''){
    const cls = ['taif-control-text', extraClass].filter(Boolean).join(' ');
    return `<span class="${escapeHtml(cls)}">${content}</span>`;
  }

  function createAnimationFrameScheduler(callback){
    let frame = 0;
    const api = {
      schedule(){
        if(frame) return;
        frame = root.requestAnimationFrame(() => {
          frame = 0;
          callback();
        });
      },
      cancel(){
        if(frame) root.cancelAnimationFrame(frame);
        frame = 0;
      }
    };
    return api;
  }

  function readOnlineState(){
    return root.__TAIF_PUBLIC_STATE__ || null;
  }

  function onlineStateSet(key, value){
    try{
      if(typeof value === 'string'){
        root.__TAIF_PUBLIC_STATE__ = JSON.parse(value);
      }else{
        root.__TAIF_PUBLIC_STATE__ = value;
      }
    }catch{}
  }

  // Current TAIF reference modules read from localState/readLocalState.
  // In this standalone public display, those names are mapped to the same
  // read-only in-memory public state pulled from Cloudflare. Nothing is written
  // back to the main project from this display.
  function readLocalState(){
    return readOnlineState();
  }

  function localStateSet(key, value){
    return onlineStateSet(key, value);
  }

  function emit(name, detail){
    const set = listeners.get(name);
    if(set){
      Array.from(set).forEach((listener) => {
        try{ listener(detail); }catch(error){ taifDebugWarn('[TAIF public display] listener failed', error); }
      });
    }
    try{ root.dispatchEvent(new CustomEvent(name, { detail })); }catch{}
  }

  function on(name, handler){
    if(!name || typeof handler !== 'function') return () => {};
    if(!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(handler);
    return () => {
      const set = listeners.get(name);
      if(set) set.delete(handler);
    };
  }

  TAIF.core = TAIF.core || {};
  TAIF.core.moduleKeys = Object.assign({
    currencyDomain:'taif-currency-management-module-v1',
    currencyManagement:'taif-currency-management-module-v1'
  }, TAIF.core.moduleKeys || {});
  TAIF.core.utils = Object.assign(TAIF.core.utils || {}, {
    clone,
    escapeHtml,
    runCleanupSlot,
    runCleanupCallbacks,
    wrapControlTextMarkup,
    createAnimationFrameScheduler,
    readOnlineState,
    onlineStateSet,
    readLocalState,
    localStateSet
  });
  TAIF.core.events = Object.assign(TAIF.core.events || {}, {
    EVENT_NAMES:{ CURRENCY_UPDATED:'taif:currency-domain-updated' },
    on,
    emit
  });

  TAIF.__viewRenderers = TAIF.__viewRenderers || {};
  TAIF.__viewCleanups = TAIF.__viewCleanups || {};
  TAIF.registerViewRenderer = function registerViewRenderer(name, renderer){
    if(name && typeof renderer === 'function') TAIF.__viewRenderers[name] = renderer;
  };
  TAIF.registerViewCleanup = function registerViewCleanup(name, cleanup){
    if(name && typeof cleanup === 'function') TAIF.__viewCleanups[name] = cleanup;
  };

  const currencyToFlag = {
    USD:'us', EUR:'eu', SYP:'sy', TRY:'tr', SAR:'sa', AED:'ae', JOD:'jo', GBP:'gb',
    CHF:'ch', CAD:'ca', AUD:'au', SEK:'se', NOK:'no', DKK:'dk', KWD:'kw',
    QAR:'qa', BHD:'bh', OMR:'om', EGP:'eg', IQD:'iq', LBP:'lb', LYD:'ly',
    MAD:'ma', DZD:'dz', TND:'tn', RUB:'ru', CNY:'cn', JPY:'jp'
  };

  function normalizeFlagCode(value){
    const raw = String(value ?? '').trim().toLowerCase();
    if(!raw) return 'xx';
    const upper = raw.toUpperCase();
    if(currencyToFlag[upper]) return currencyToFlag[upper];
    const safe = raw.replace(/[^a-z]/g,'').slice(0, 3);
    return safe || 'xx';
  }

  function resolveFlagAsset(flagOrCode, variant = 'circle'){
    const countryCode = normalizeFlagCode(flagOrCode);
    const folder = variant === 'rect' ? 'rect' : 'circle';
    return {
      src:`assets/flags/${folder}/${countryCode}.png`,
      countryCode
    };
  }

  function getFlagMeta(flagOrCode){
    const asset = resolveFlagAsset(flagOrCode, 'circle');
    return {
      code:asset.countryCode,
      countryCode:String(asset.countryCode || 'xx').toUpperCase(),
      currencyName:asset.countryCode,
      srcCircle:asset.src,
      srcRect:asset.src
    };
  }

  TAIF.assets = TAIF.assets || {};
  TAIF.assets.flags = Object.assign(TAIF.assets.flags || {}, {
    resolveFlagAsset,
    getFlagMeta
  });
})();