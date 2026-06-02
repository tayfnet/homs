(()=>{
  'use strict';

  const root = window;
  const TAIF = root.TAIF || {};
  const config = root.TAIF_PUBLIC_PRICE_CONFIG || {};
  const panel = document.querySelector('main.taif-public-price-app.panel[data-view="price-screen"]');
  const statusEl = document.querySelector('[data-taif-public-price-status]');

  let initialized = false;
  let pollTimer = 0;
  let consecutiveFailures = 0;
  let lastStateSignature = '';
  let lastAppliedAt = 0;
  let lastRefreshAt = 0;
  let refreshInFlight = false;
  let refreshQueued = false;
  let stopped = false;
  let lastFailureLogAt = 0;
  let lastFailureLogSignature = '';
  let networkHoldUntil = 0;
  let networkFailureCount = 0;
  const NETWORK_FAILURE_STORAGE_KEY = 'taif-public-display-network-failure-v2';
  const RECENT_NETWORK_FAILURE_MS = 45000;

  function safeLocalStorage(){
    try{ return window.localStorage || null; }catch{ return null; }
  }

  function rememberNetworkFailure(error){
    try{
      safeLocalStorage()?.setItem(NETWORK_FAILURE_STORAGE_KEY, JSON.stringify({
        at:Date.now(),
        message:String(error?.message || error || '').slice(0, 260),
        code:String(error?.code || '').slice(0, 80)
      }));
    }catch{}
  }

  function clearRememberedNetworkFailure(){
    try{ safeLocalStorage()?.removeItem(NETWORK_FAILURE_STORAGE_KEY); }catch{}
  }

  function applyRememberedNetworkFailure(){
    try{
      const raw = safeLocalStorage()?.getItem(NETWORK_FAILURE_STORAGE_KEY);
      if(!raw) return;
      const parsed = JSON.parse(raw);
      const age = parsed?.at ? Date.now() - Number(parsed.at) : Infinity;
      if(age >= 0 && age < RECENT_NETWORK_FAILURE_MS && !isNativeOffline()){
        networkFailureCount = Math.max(1, networkFailureCount);
        networkHoldUntil = Date.now() + Math.max(1200, Math.min(5000, RECENT_NETWORK_FAILURE_MS - age));
      }
    }catch{}
  }

  function debugWarn(...args){
    if(config.DEBUG) console.warn(...args);
  }

  function debugError(...args){
    if(config.DEBUG) console.error(...args);
  }

  function logRefreshFailure(error){
    if(!config.DEBUG) return;
    const now = Date.now();
    const signature = `${error?.status || ''}:${String(error?.message || error || '').slice(0, 240)}`;
    if(signature !== lastFailureLogSignature || now - lastFailureLogAt > 30000){
      lastFailureLogSignature = signature;
      lastFailureLogAt = now;
      debugWarn('[TAIF public display] refresh failed', error);
    }
  }

  function showStatus(message, force = false){
    if(!statusEl || (!config.SHOW_STATUS && !force)) return;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-visible', Boolean(message));
  }

  function normalizeUrl(url){
    return String(url || '').trim().replace(/\/+$/,'');
  }

  function isNativeOffline(){
    try{ return typeof navigator !== 'undefined' && navigator.onLine === false; }catch{ return false; }
  }

  function isNetworkPaused(){
    return isNativeOffline() || (networkHoldUntil && Date.now() < networkHoldUntil);
  }

  function makeNetworkError(){
    const error = new Error('الاتصال بالإنترنت غير متوفر حاليًا، وسيتم تحديث الأسعار تلقائيًا عند عودة الاتصال.');
    error.status = 0;
    error.code = 'TAIF_PUBLIC_DISPLAY_OFFLINE';
    return error;
  }

  function isNetworkError(error){
    const code = String(error?.code || '').toUpperCase();
    const status = Number(error?.status);
    const message = String(error?.message || error || '');
    return status === 0
      || status === 408
      || code === 'TAIF_PUBLIC_DISPLAY_OFFLINE'
      || /failed\s*to\s*fetch|network\s*error|load\s*failed|internet\s*disconnected|err_internet_disconnected|err_network_changed|err_connection/i.test(message);
  }

  function noteNetworkSuccess(){
    networkFailureCount = 0;
    networkHoldUntil = 0;
    clearRememberedNetworkFailure();
  }

  function noteNetworkFailure(error){
    if(!isNetworkError(error)) return false;
    networkFailureCount += 1;
    rememberNetworkFailure(error);
    if(isNativeOffline()) networkHoldUntil = 0;
    else{
      const delay = Math.min(30000, Math.round(1100 * Math.pow(1.7, Math.min(6, networkFailureCount - 1)) + Math.random() * 300));
      networkHoldUntil = Date.now() + delay;
    }
    return true;
  }

  function getWorkspaceId(){
    return String(config.WORKSPACE_ID || config.ORG_ID || 'default').trim() || 'default';
  }

  function getWatchedStateKey(){
    return String(config.STATE_KEY || 'taif-currency-management-module-v1').trim() || 'taif-currency-management-module-v1';
  }

  function clonePlain(value){
    if(value == null || typeof value !== 'object') return value;
    try{ return JSON.parse(JSON.stringify(value)); }catch{}
    return Array.isArray(value) ? value.slice() : { ...value };
  }

  function stableStringify(value){
    if(value == null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if(Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }

  function stateSignature(state){
    if(!state || typeof state !== 'object') return '';
    const rev = state.__taifDisplayRevision ?? state.__taifDomainRevision ?? state.revision;
    const hash = state.__taifDisplayPayloadHash ?? state.payloadHash ?? state.payload_hash;
    const updated = state.__taifDisplayUpdatedAt ?? state.updatedAt ?? state.updated_at ?? state.logicalUpdatedAt ?? state.logical_updated_at;
    if(rev != null || hash || updated) return `${rev ?? ''}:${hash || ''}:${updated || ''}`;
    return stableStringify(state);
  }

  function buildRpcUrl(rpcName){
    // لا نضيف أي query parameter على /rpc؛ منع الكاش يتم من خلال POST + headers فقط.
    return `${normalizeUrl(config.SUPABASE_URL)}/rest/v1/rpc/${encodeURIComponent(rpcName)}`;
  }

  async function callRpc(rpcName){
    const url = normalizeUrl(config.SUPABASE_URL);
    const key = String(config.SUPABASE_ANON_KEY || '').trim();
    if(!url || !key) throw new Error('إعدادات Supabase غير مكتملة في js/config.js');
    if(isNetworkPaused()) throw makeNetworkError();

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeoutMs = Math.max(2500, Number(config.REQUEST_TIMEOUT_MS || 7000));
    const timeoutId = controller ? root.setTimeout(() => controller.abort(), timeoutMs) : 0;

    try{
      const response = await fetch(buildRpcUrl(rpcName), {
        method:'POST',
        headers:{
          'apikey':key,
          'Authorization':`Bearer ${key}`,
          'Content-Type':'application/json',
          'Accept':'application/json',
          'Cache-Control':'no-store, no-cache, must-revalidate, max-age=0',
          'Pragma':'no-cache',
          'Accept-Profile':'public',
          'Content-Profile':'public',
          'X-TAIF-Public-Display-Version':String(config.BUILD_VERSION || 'newdb-full')
        },
        body:JSON.stringify({ target_workspace:getWorkspaceId() }),
        cache:'no-store',
        credentials:'omit',
        keepalive:false,
        signal:controller ? controller.signal : undefined
      });

      if(!response.ok){
        const text = await response.text().catch(() => '');
        const error = new Error(`${rpcName} failed: ${response.status} ${text}`);
        error.status = response.status;
        throw error;
      }
      noteNetworkSuccess();
      return response.json();
    }catch(error){
      if(error?.name === 'AbortError'){
        const timeoutError = new Error('انتهت مهلة قراءة أسعار شاشة العرض من قاعدة البيانات.');
        timeoutError.status = 408;
        noteNetworkFailure(timeoutError);
        throw timeoutError;
      }
      if(noteNetworkFailure(error)) throw makeNetworkError();
      throw error;
    }finally{
      if(timeoutId) root.clearTimeout(timeoutId);
    }
  }

  function attachDisplayMeta(payload, metaSource = {}){
    const state = clonePlain(payload);
    if(!state || typeof state !== 'object' || Array.isArray(state)) return null;
    const workspace = metaSource.workspaceId || metaSource.workspace_id || state.__taifDisplayWorkspace || getWorkspaceId();
    const stateKey = metaSource.stateKey || metaSource.state_key || state.__taifDisplayStateKey || getWatchedStateKey();
    const revision = metaSource.revision ?? metaSource.__taifDisplayRevision ?? state.__taifDisplayRevision;
    const payloadHash = metaSource.payloadHash || metaSource.payload_hash || metaSource.__taifDisplayPayloadHash || state.__taifDisplayPayloadHash;
    const updatedAt = metaSource.updatedAt || metaSource.updated_at || metaSource.__taifDisplayUpdatedAt || state.__taifDisplayUpdatedAt || Date.now();
    state.__taifDisplaySource = metaSource.__taifDisplaySource || state.__taifDisplaySource || 'taif_domain_state';
    state.__taifDisplayWorkspace = workspace;
    state.__taifDisplayStateKey = stateKey;
    if(revision != null) state.__taifDisplayRevision = revision;
    if(payloadHash) state.__taifDisplayPayloadHash = payloadHash;
    state.__taifDisplayUpdatedAt = typeof updatedAt === 'number' ? updatedAt : Date.parse(updatedAt) || Date.now();
    return state;
  }

  function unwrapState(value, metaSource = {}){
    if(value == null) return null;
    if(Array.isArray(value)){
      for(const item of value){
        const unwrapped = unwrapState(item, metaSource);
        if(unwrapped) return unwrapped;
      }
      return null;
    }
    if(typeof value !== 'object') return null;
    if(value.ok === false) return null;

    if(Array.isArray(value.currencies)) return attachDisplayMeta(value, metaSource);

    if(value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)){
      const sourceMeta = { ...value, ...metaSource };
      if(Array.isArray(value.payload.currencies)) return attachDisplayMeta(value.payload, sourceMeta);
      const nestedPayload = unwrapState(value.payload, sourceMeta);
      if(nestedPayload) return nestedPayload;
    }

    if(value.state && typeof value.state === 'object') return unwrapState(value.state, { ...value, ...metaSource });
    if(value.data && typeof value.data === 'object') return unwrapState(value.data, { ...value, ...metaSource });
    return null;
  }

  function sanitizeFetchedState(value, metaSource = {}){
    const state = unwrapState(value, metaSource);
    if(!state || typeof state !== 'object' || Array.isArray(state)) return null;
    if(!Array.isArray(state.currencies)) return null;
    if(!Array.isArray(state.rateBooks)) state.rateBooks = [];
    if(!Array.isArray(state.pairRegistry)) state.pairRegistry = [];
    if(!Array.isArray(state.rateRecords)) state.rateRecords = [];
    return state;
  }

  async function fetchState(){
    try{
      return await callRpc(config.RPC_NAME || 'taif_public_price_display_state');
    }catch(primaryError){
      if(config.FALLBACK_RPC_NAME){
        try{ return await callRpc(config.FALLBACK_RPC_NAME); }catch{}
      }
      throw primaryError;
    }
  }

  function renderPriceScreen(){
    if(!panel || !TAIF.__viewRenderers || typeof TAIF.__viewRenderers['price-screen'] !== 'function') return;
    try{
      TAIF.__viewRenderers['price-screen']({ panel, force:true });
      initialized = true;
    }catch(error){
      debugError('[TAIF public display] render failed', error);
      showStatus('تعذر عرض شاشة الأسعار', true);
    }
  }

  function applyState(rawState, reason = 'refresh', { force = false } = {}){
    const nextState = sanitizeFetchedState(rawState);
    if(!nextState) return false;

    const signature = stateSignature(nextState);
    if(!force && signature && signature === lastStateSignature && initialized){
      consecutiveFailures = 0;
      showStatus('');
      return true;
    }

    lastStateSignature = signature || stableStringify(nextState);
    lastAppliedAt = Date.now();
    root.__TAIF_PUBLIC_STATE__ = nextState;
    consecutiveFailures = 0;
    showStatus('');
    renderPriceScreen();

    try{
      TAIF.core?.events?.emit?.('taif:currency-domain-updated', { state:nextState, source:'public-display', reason });
    }catch{}

    return true;
  }

  async function refresh(reason = 'poll'){
    if(stopped) return;
    if(isNetworkPaused()){
      if(reason !== 'poll' || consecutiveFailures >= 1) showStatus('الاتصال غير متوفر، سيتم تحديث الأسعار تلقائيًا عند عودة الاتصال', true);
      return;
    }
    if(refreshInFlight){
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    lastRefreshAt = Date.now();

    try{
      const rawState = await fetchState();
      if(applyState(rawState, reason, { force:reason === 'manual' || reason === 'first' })) return;
      if(!initialized) showStatus('لا توجد بيانات أسعار منشورة بعد من المشروع الأساسي', true);
    }catch(error){
      consecutiveFailures += 1;
      logRefreshFailure(error);
      if(consecutiveFailures >= 2){
        const isMissingRpc = error?.status === 404 || String(error?.message || '').includes('Could not find the function');
        const isOffline = isNetworkError(error);
        showStatus(isOffline ? 'الاتصال غير متوفر، سيتم تحديث الأسعار تلقائيًا عند عودة الاتصال' : (isMissingRpc ? 'لم يتم تنفيذ ملف SQL الخاص بشاشة العرض بعد' : 'تعذر تحديث الأسعار من قاعدة مشروع طيف'), true);
      }
    }finally{
      refreshInFlight = false;
      if(refreshQueued){
        refreshQueued = false;
        root.setTimeout(() => refresh('queued'), 40);
      }
    }
  }

  function startPolling(){
    if(pollTimer) root.clearInterval(pollTimer);
    const interval = Math.max(800, Number(config.POLL_INTERVAL_MS || 1200));
    pollTimer = root.setInterval(() => {
      if(isNetworkPaused()) return;
      refresh('poll');
    }, interval);
  }

  function bindLifecycleRefresh(){
    root.addEventListener('online', () => {
      networkHoldUntil = Date.now() + 700;
      root.setTimeout(() => refresh('online'), 760);
    });
    root.addEventListener('offline', () => {
      networkFailureCount = Math.max(1, networkFailureCount);
      networkHoldUntil = 0;
      showStatus('الاتصال غير متوفر، سيتم تحديث الأسعار تلقائيًا عند عودة الاتصال', true);
    });
    root.addEventListener('focus', () => refresh('focus'));
    root.addEventListener('pageshow', () => refresh('pageshow'));
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible') refresh('visible');
    });
    root.addEventListener('beforeunload', () => {
      stopped = true;
      if(pollTimer) root.clearInterval(pollTimer);
      const cleanup = TAIF.__viewCleanups && TAIF.__viewCleanups['price-screen'];
      if(typeof cleanup === 'function'){
        try{ cleanup(); }catch{}
      }
    });
  }

  function start(){
    showStatus('جاري تحميل أسعار طيف...', Boolean(config.SHOW_STATUS));
    refresh('first');
    startPolling();
    bindLifecycleRefresh();
  }

  TAIF.publicPriceDisplay = Object.assign(TAIF.publicPriceDisplay || {}, {
    version:'new-supabase-main-project-full-polling-v4-network-firewall',
    refresh:() => refresh('manual'),
    diagnostics:() => ({
      initialized,
      consecutiveFailures,
      workspaceId:getWorkspaceId(),
      stateKey:getWatchedStateKey(),
      stateSignature:lastStateSignature,
      lastAppliedAt,
      lastRefreshAt,
      networkPaused:isNetworkPaused(),
      networkFailureCount,
      networkHoldUntil,
      pollIntervalMs:Math.max(800, Number(config.POLL_INTERVAL_MS || 1200)),
      supabaseUrl:normalizeUrl(config.SUPABASE_URL || ''),
      projectRef:String(config.PROJECT_REF || '')
    })
  });

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', start, { once:true });
  }else{
    start();
  }
})();
