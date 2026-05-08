(()=>{
  const root = window;
  const TAIF = root.TAIF || {};
  const config = root.TAIF_PUBLIC_PRICE_CONFIG || {};
  const panel = document.querySelector('main.taif-public-price-app.panel[data-view="price-screen"]');
  const statusEl = document.querySelector('[data-taif-public-price-status]');
  let initialized = false;
  let timer = 0;
  let consecutiveFailures = 0;

  function showStatus(message, force = false){
    if(!statusEl || (!config.SHOW_STATUS && !force)) return;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('is-visible', Boolean(message));
  }

  function normalizeUrl(url){
    return String(url || '').trim().replace(/\/+$/,'');
  }

  function buildRpcUrl(rpcName){
    return `${normalizeUrl(config.SUPABASE_URL)}/rest/v1/rpc/${encodeURIComponent(rpcName)}`;
  }

  async function callRpc(rpcName){
    const url = buildRpcUrl(rpcName);
    const headers = {
      'apikey': config.SUPABASE_ANON_KEY || '',
      'Authorization': `Bearer ${config.SUPABASE_ANON_KEY || ''}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
    const body = {};
    if(config.ORG_ID) body.target_org = config.ORG_ID;

    const response = await fetch(url, {
      method:'POST',
      headers,
      body:JSON.stringify(body),
      cache:'no-store'
    });

    if(!response.ok){
      const text = await response.text().catch(() => '');
      throw new Error(`${rpcName} failed: ${response.status} ${text}`);
    }

    return response.json();
  }

  async function fetchState(){
    if(!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) return null;

    try{
      return await callRpc(config.RPC_NAME || 'taif_public_price_display_state');
    }catch(primaryError){
      if(config.FALLBACK_RPC_NAME){
        try{
          return await callRpc(config.FALLBACK_RPC_NAME);
        }catch(fallbackError){
          throw primaryError;
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

  async function refresh(){
    try{
      const rawState = await fetchState();
      const nextState = sanitizeFetchedState(rawState);
      if(nextState){
        root.__TAIF_PUBLIC_STATE__ = nextState;
        consecutiveFailures = 0;
        showStatus('');
        renderPriceScreen();
        TAIF.core?.events?.emit?.('taif:currency-domain-updated', { state: nextState });
        return;
      }
      if(!initialized) renderPriceScreen();
    }catch(error){
      consecutiveFailures += 1;
      console.warn('[TAIF public display] refresh failed', error);
      if(!initialized) renderPriceScreen();
      if(consecutiveFailures >= 2){
        showStatus('تعذر تحديث الأسعار من القاعدة', true);
      }
    }
  }

  function start(){
    renderPriceScreen();
    refresh();
    const interval = Math.max(1000, Number(config.POLL_INTERVAL_MS || 3000));
    timer = root.setInterval(refresh, interval);
    root.addEventListener('beforeunload', () => {
      if(timer) root.clearInterval(timer);
      const cleanup = TAIF.__viewCleanups && TAIF.__viewCleanups['price-screen'];
      if(typeof cleanup === 'function'){
        try{ cleanup(); }catch{}
      }
    });
  }

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', start, { once:true });
  }else{
    start();
  }
})();