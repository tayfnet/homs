(()=>{
  'use strict';

  const root = window;
  const TAIF = root.TAIF || (root.TAIF = {});
  const config = root.TAIF_PUBLIC_PRICE_CONFIG || {};
  const panel = document.querySelector('main.taif-public-price-app.panel[data-view="price-screen"]');
  const statusEl = document.querySelector('[data-taif-public-price-status]');

  let initialized = false;
  let pollTimer = 0;
  let consecutiveFailures = 0;
  let lastStateSignature = '';
  let refreshInFlight = false;
  let refreshQueued = false;
  let lastRefreshAt = '';

  function showStatus(message, force = false){
    if(!statusEl || (!config.SHOW_STATUS && !force)) return;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-visible', Boolean(message));
  }

  function toText(value){
    return String(value ?? '').trim();
  }

  function normalizeUrl(url){
    return toText(url).replace(/\/+$/,'');
  }

  function getApiBaseUrl(){
    return normalizeUrl(config.API_BASE_URL || config.apiBaseUrl || config.CLOUDFLARE_API_URL || config.cloudflareApiUrl || '');
  }

  function getWorkspaceId(){
    return toText(config.WORKSPACE_ID || config.workspaceId || config.ORG_ID || 'default') || 'default';
  }

  function getStateKey(){
    return toText(config.STATE_KEY || config.stateKey || 'taif-currency-management-module-v1') || 'taif-currency-management-module-v1';
  }

  function buildRpcUrl(rpcName){
    const base = getApiBaseUrl();
    if(!base) throw new Error('رابط Cloudflare Worker غير مضبوط في js/config.js');
    return `${base}/api/rpc/${encodeURIComponent(toText(rpcName))}`;
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
    const updated = state.updatedAt ?? state.updated_at ?? state.__taifDisplayUpdatedAt;
    if(rev || hash) return `${rev || ''}:${hash || ''}:${updated || ''}`;
    return stableStringify(state);
  }

  async function callRpc(rpcName){
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutMs = Math.max(5000, Number(config.REQUEST_TIMEOUT_MS || config.requestTimeoutMs || 20000));
    const timeoutId = controller ? root.setTimeout(() => controller.abort(), timeoutMs) : 0;
    const headers = {
      'Content-Type':'application/json',
      'Accept':'application/json'
    };
    const appKey = toText(config.APP_KEY || config.appKey || '');
    if(appKey) headers.Authorization = `Bearer ${appKey}`;
    const workspaceId = getWorkspaceId();
    const body = {
      target_workspace: workspaceId,
      p_workspace_id: workspaceId,
      workspaceId,
      p_state_key: getStateKey()
    };

    try{
      const response = await fetch(buildRpcUrl(rpcName), {
        method:'POST',
        headers,
        body:JSON.stringify(body),
        cache:'no-store',
        credentials:'omit',
        signal:controller ? controller.signal : undefined
      });
      const text = await response.text();
      let data = null;
      if(text){
        try{ data = JSON.parse(text); }catch{ data = text; }
      }
      if(!response.ok){
        const message = toText(data?.message || data?.error || data) || `فشل الاتصال (${response.status})`;
        const error = new Error(message);
        error.status = response.status;
        error.details = data;
        throw error;
      }
      return data;
    }catch(error){
      if(error && error.name === 'AbortError'){
        throw new Error('انتهت مهلة الاتصال بخدمة Cloudflare.');
      }
      throw error;
    }finally{
      if(timeoutId) try{ root.clearTimeout(timeoutId); }catch{}
    }
  }

  function unwrapState(value){
    if(!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if(value.ok === false) return null;
    if(value.state && typeof value.state === 'object' && !Array.isArray(value.state)) return value.state;
    if(value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)) return value.payload;
    if(value.data && typeof value.data === 'object' && !Array.isArray(value.data)) return unwrapState(value.data);
    return value;
  }

  async function fetchState(){
    const rpcName = toText(config.RPC_NAME || config.rpcName || 'taif_public_price_display_state') || 'taif_public_price_display_state';
    return unwrapState(await callRpc(rpcName));
  }

  function sanitizeFetchedState(value){
    const state = unwrapState(value);
    if(!state || typeof state !== 'object') return null;
    if(Array.isArray(state)) return null;
    if(!Array.isArray(state.currencies)) return null;
    if(!Array.isArray(state.rateBooks)) state.rateBooks = [];
    if(!Array.isArray(state.pairRegistry)) state.pairRegistry = [];
    if(!Array.isArray(state.rateRecords)) state.rateRecords = [];
    return state;
  }

  function renderPriceScreen(force = false){
    if(!panel || !TAIF.__viewRenderers || typeof TAIF.__viewRenderers['price-screen'] !== 'function') return;
    try{
      TAIF.__viewRenderers['price-screen']({ panel, force });
      initialized = true;
    }catch(error){
      console.error('[TAIF public display] render failed', error);
      showStatus('تعذر عرض شاشة الأسعار', true);
    }
  }

  async function refresh(reason = 'poll'){
    if(refreshInFlight){
      refreshQueued = true;
      return;
    }
    refreshInFlight = true;
    try{
      const rawState = await fetchState();
      const nextState = sanitizeFetchedState(rawState);
      if(nextState){
        const signature = stateSignature(nextState);
        if(signature && signature === lastStateSignature && initialized){
          consecutiveFailures = 0;
          lastRefreshAt = new Date().toISOString();
          showStatus('');
          return;
        }
        lastStateSignature = signature;
        root.__TAIF_PUBLIC_STATE__ = nextState;
        consecutiveFailures = 0;
        lastRefreshAt = new Date().toISOString();
        showStatus('');
        renderPriceScreen(reason === 'first');
        TAIF.core?.events?.emit?.('taif:currency-domain-updated', { state: nextState, source:'public-display-cloudflare', reason });
        return;
      }
      if(!initialized) showStatus('لا توجد بيانات أسعار منشورة بعد', true);
    }catch(error){
      consecutiveFailures += 1;
      console.warn('[TAIF public display] refresh failed', error);
      if(consecutiveFailures >= 2){
        showStatus('تعذر تحديث الأسعار من Cloudflare', true);
      }
    }finally{
      refreshInFlight = false;
      if(refreshQueued){
        refreshQueued = false;
        root.setTimeout(() => refresh('queued'), 80);
      }
    }
  }

  function start(){
    showStatus('جاري تحميل أسعار طيف...', Boolean(config.SHOW_STATUS));
    refresh('first');
    const interval = Math.max(1500, Number(config.POLL_INTERVAL_MS || config.pollIntervalMs || 5000));
    pollTimer = root.setInterval(() => refresh('poll'), interval);
    root.addEventListener('online', () => refresh('online'));
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible') refresh('visible');
    });
    root.addEventListener('beforeunload', () => {
      if(pollTimer) root.clearInterval(pollTimer);
      const cleanup = TAIF.__viewCleanups && TAIF.__viewCleanups['price-screen'];
      if(typeof cleanup === 'function'){
        try{ cleanup(); }catch{}
      }
    });
  }

  TAIF.publicPriceDisplay = Object.assign(TAIF.publicPriceDisplay || {}, {
    refresh:() => refresh('manual'),
    diagnostics:() => ({
      initialized,
      consecutiveFailures,
      apiBaseUrl:getApiBaseUrl(),
      workspaceId:getWorkspaceId(),
      stateKey:getStateKey(),
      stateSignature:lastStateSignature,
      lastRefreshAt
    })
  });

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', start, { once:true });
  }else{
    start();
  }
})();
