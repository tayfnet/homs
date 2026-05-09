(()=>{
  const root = window;
  const TAIF = root.TAIF || {};
  const config = root.TAIF_PUBLIC_PRICE_CONFIG || {};
  const panel = document.querySelector('main.taif-public-price-app.panel[data-view="price-screen"]');
  const statusEl = document.querySelector('[data-taif-public-price-status]');

  const pollInterval = Math.max(1000, Number(config.POLL_INTERVAL_MS || 3000));
  const requestTimeoutMs = Math.max(5000, Number(config.REQUEST_TIMEOUT_MS || 12000));
  const retryIntervalMs = Math.max(1000, Number(config.RETRY_INTERVAL_MS || 2500));
  const maxRetryIntervalMs = Math.max(retryIntervalMs, Number(config.MAX_RETRY_INTERVAL_MS || 15000));
  const watchdogIntervalMs = Math.max(10000, Math.min(30000, pollInterval * 5));

  let initialized = false;
  let stopped = false;
  let nextTimer = 0;
  let watchdogTimer = 0;
  let refreshInFlight = false;
  let pendingRefresh = false;
  let activeController = null;
  let activeRequestStartedAt = 0;
  let lastAttemptAt = 0;
  let lastSuccessAt = 0;
  let consecutiveFailures = 0;

  function showStatus(message, force = false){
    if(!statusEl || (!config.SHOW_STATUS && !force)) return;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-visible', Boolean(message));
  }

  function hideStatus(){
    if(!statusEl) return;
    statusEl.textContent = '';
    statusEl.classList.remove('is-visible');
  }

  function normalizeUrl(url){
    return String(url || '').trim().replace(/\/+$/,'');
  }

  function buildRpcUrl(rpcName){
    return `${normalizeUrl(config.SUPABASE_URL)}/rest/v1/rpc/${encodeURIComponent(rpcName)}`;
  }

  function clearNextTimer(){
    if(nextTimer){
      root.clearTimeout(nextTimer);
      nextTimer = 0;
    }
  }

  function scheduleRefresh(delay = pollInterval){
    if(stopped) return;
    clearNextTimer();
    nextTimer = root.setTimeout(() => {
      nextTimer = 0;
      refresh();
    }, Math.max(0, Number(delay) || 0));
  }

  function requestImmediateRefresh(){
    if(stopped) return;

    if(refreshInFlight){
      pendingRefresh = true;
      const requestAge = Date.now() - activeRequestStartedAt;
      if(activeController && requestAge > requestTimeoutMs){
        try{ activeController.abort(); }catch{}
      }
      return;
    }

    scheduleRefresh(0);
  }

  function createTimeoutError(rpcName){
    const error = new Error(`${rpcName} request timed out after ${requestTimeoutMs}ms`);
    error.name = 'TimeoutError';
    return error;
  }

  async function fetchWithTimeout(url, options, rpcName){
    const canAbort = typeof AbortController === 'function';
    const controller = canAbort ? new AbortController() : null;
    const timeout = root.setTimeout(() => {
      if(controller){
        try{ controller.abort(); }catch{}
      }
    }, requestTimeoutMs);

    activeController = controller;
    activeRequestStartedAt = Date.now();

    const request = fetch(url, {
      ...options,
      signal: controller ? controller.signal : undefined
    });

    try{
      if(controller) return await request;

      return await Promise.race([
        request,
        new Promise((_, reject) => root.setTimeout(() => reject(createTimeoutError(rpcName)), requestTimeoutMs))
      ]);
    }catch(error){
      if(error && error.name === 'AbortError') throw createTimeoutError(rpcName);
      throw error;
    }finally{
      root.clearTimeout(timeout);
      if(activeController === controller) activeController = null;
    }
  }

  async function callRpc(rpcName){
    const url = buildRpcUrl(rpcName);
    const headers = {
      'apikey': config.SUPABASE_ANON_KEY || '',
      'Authorization': `Bearer ${config.SUPABASE_ANON_KEY || ''}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Cache-Control': 'no-cache, no-store, max-age=0',
      'Pragma': 'no-cache'
    };
    const body = {};
    if(config.ORG_ID) body.target_org = config.ORG_ID;

    const response = await fetchWithTimeout(url, {
      method:'POST',
      headers,
      body:JSON.stringify(body),
      cache:'no-store',
      credentials:'omit'
    }, rpcName);

    if(!response.ok){
      const text = await response.text().catch(() => '');
      throw new Error(`${rpcName} failed: ${response.status} ${text}`);
    }

    return response.json();
  }

  async function fetchState(){
    if(!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) return null;

    const primaryName = config.RPC_NAME || 'taif_public_price_display_state';
    try{
      return await callRpc(primaryName);
    }catch(primaryError){
      if(config.FALLBACK_RPC_NAME && config.FALLBACK_RPC_NAME !== primaryName){
        try{
          return await callRpc(config.FALLBACK_RPC_NAME);
        }catch(fallbackError){
          fallbackError.primaryError = primaryError;
          throw fallbackError;
        }
      }
      throw primaryError;
    }
  }

  function sanitizeFetchedState(value){
    if(!value || typeof value !== 'object') return null;
    if(Array.isArray(value)) return null;
    if(!Array.isArray(value.currencies)) return null;
    return value;
  }

  function renderPriceScreen(){
    if(!panel || !TAIF.__viewRenderers || typeof TAIF.__viewRenderers['price-screen'] !== 'function') return;
    try{
      TAIF.__viewRenderers['price-screen']({ panel });
      initialized = true;
    }catch(error){
      console.error('[TAIF public display] render failed', error);
      showStatus('تعذر عرض شاشة الأسعار', true);
    }
  }

  function getRetryDelay(){
    const exponentialDelay = Math.round(retryIntervalMs * Math.pow(1.45, Math.max(0, consecutiveFailures - 1)));
    return Math.min(maxRetryIntervalMs, Math.max(retryIntervalMs, exponentialDelay));
  }

  function handleRefreshFailure(error){
    consecutiveFailures += 1;
    console.warn('[TAIF public display] refresh failed; retrying automatically', error);

    if(!initialized) renderPriceScreen();

    const hasLastGoodState = Boolean(lastSuccessAt || root.__TAIF_PUBLIC_STATE__);
    if(!hasLastGoodState && consecutiveFailures >= 3){
      showStatus('جاري إعادة محاولة تحديث نشرة الأسعار تلقائيًا', true);
    }else if(hasLastGoodState && config.SHOW_STATUS && consecutiveFailures >= 6){
      showStatus('انقطاع مؤقت في تحديث نشرة الأسعار، وستتم إعادة المحاولة تلقائيًا');
    }
  }

  async function refresh(){
    if(stopped) return;

    if(refreshInFlight){
      pendingRefresh = true;
      return;
    }

    refreshInFlight = true;
    lastAttemptAt = Date.now();
    let refreshSucceeded = false;

    try{
      const rawState = await fetchState();
      const nextState = sanitizeFetchedState(rawState);

      if(nextState){
        root.__TAIF_PUBLIC_STATE__ = nextState;
        consecutiveFailures = 0;
        lastSuccessAt = Date.now();
        refreshSucceeded = true;
        hideStatus();
        renderPriceScreen();
        return;
      }

      if(!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY){
        refreshSucceeded = true;
        if(!initialized) renderPriceScreen();
        return;
      }

      throw new Error('Invalid or empty price display state received from Supabase');
    }catch(error){
      handleRefreshFailure(error);
    }finally{
      refreshInFlight = false;
      activeController = null;

      if(stopped) return;

      if(pendingRefresh){
        pendingRefresh = false;
        scheduleRefresh(0);
        return;
      }

      scheduleRefresh(refreshSucceeded ? pollInterval : getRetryDelay());
    }
  }

  function bindRecoveryEvents(){
    const wake = () => requestImmediateRefresh();
    const visibleWake = () => {
      if(!document.hidden) requestImmediateRefresh();
    };
    const pageShowWake = (event) => {
      if(event && event.persisted) requestImmediateRefresh();
      else requestImmediateRefresh();
    };

    root.addEventListener('online', wake, { passive:true });
    root.addEventListener('focus', wake, { passive:true });
    root.addEventListener('pageshow', pageShowWake, { passive:true });
    document.addEventListener('visibilitychange', visibleWake, { passive:true });
    document.addEventListener('resume', wake, { passive:true });

    return () => {
      root.removeEventListener('online', wake);
      root.removeEventListener('focus', wake);
      root.removeEventListener('pageshow', pageShowWake);
      document.removeEventListener('visibilitychange', visibleWake);
      document.removeEventListener('resume', wake);
    };
  }

  function startWatchdog(){
    watchdogTimer = root.setInterval(() => {
      if(stopped) return;

      const now = Date.now();
      const activeAge = refreshInFlight ? now - activeRequestStartedAt : 0;
      if(refreshInFlight && activeController && activeAge > requestTimeoutMs + 1000){
        pendingRefresh = true;
        try{ activeController.abort(); }catch{}
        return;
      }

      const maxSilence = Math.max(pollInterval * 4, 20000);
      if(!refreshInFlight && (!lastAttemptAt || now - lastAttemptAt > maxSilence)){
        requestImmediateRefresh();
      }
    }, watchdogIntervalMs);
  }

  function start(){
    const unbindRecoveryEvents = bindRecoveryEvents();

    renderPriceScreen();
    refresh();
    startWatchdog();

    root.addEventListener('beforeunload', () => {
      stopped = true;
      clearNextTimer();
      if(watchdogTimer) root.clearInterval(watchdogTimer);
      if(activeController){
        try{ activeController.abort(); }catch{}
      }
      unbindRecoveryEvents();
      const cleanup = TAIF.__viewCleanups && TAIF.__viewCleanups['price-screen'];
      if(typeof cleanup === 'function'){
        try{ cleanup(); }catch{}
      }
    }, { once:true });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', start, { once:true });
  }else{
    start();
  }
})();
