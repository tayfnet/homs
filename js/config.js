window.TAIF_PUBLIC_PRICE_CONFIG = {
  // رابط Cloudflare Worker الجديد الخاص بمشروع TAIF الإنتاجي.
  API_BASE_URL: "https://taif-cloudflare-api.mhmadsayf.workers.dev",

  // endpoint عام للقراءة فقط، يقرأ حالة العملات من Cloudflare D1 عبر Worker.
  RPC_NAME: "taif_public_price_display_state",
  WORKSPACE_ID: "default",
  STATE_KEY: "taif-currency-management-module-v1",

  // اتركه فارغًا ما لم تقم بتفعيل TAIF_APP_KEY داخل Worker.
  APP_KEY: "",

  // شاشة العرض تعمل بالقراءة فقط، وتحدث الأسعار دوريًا من Cloudflare.
  POLL_INTERVAL_MS: 5000,
  REQUEST_TIMEOUT_MS: 20000,
  SHOW_STATUS: false
};
