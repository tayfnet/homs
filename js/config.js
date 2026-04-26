(()=>{
  'use strict';

  /*
   * TAIF Public Price Board configuration.
   * This is the only file you normally edit when moving the folder to another domain.
   * The screen is read-only: it never writes to Supabase and never loads the main TAIF UI.
   */
  window.TAIF_PUBLIC_PRICE_BOARD_CONFIG = Object.freeze({
    refreshIntervalMs: 5000,
    mobileBreakpointPx: 860,
    requestTimeoutMs: 3500,
    cacheKey: 'taif-public-price-board-cache-v1',

    dataSource: Object.freeze({
      projectUrl: 'https://moafcqstydkyritatguh.supabase.co',
      anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1vYWZjcXN0eWRreXJpdGF0Z3VoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4NTEyODYsImV4cCI6MjA5MDQyNzI4Nn0.XokZCzXNeKFOwiZoWYNTuZ89QNGv-bAuOxCo9aP4Yfw',
      schema: 'public',
      table: 'taif_currency_management_state',
      workspaceCode: 'main-production',
      storageKey: 'taif-currency-management-module-v1'
    }),

    compatibility: Object.freeze({
      readSameDomainLocalStorage: true,
      fallbackTables: Object.freeze(['taif_app_state', 'taif_misc_state']),
      allowBroadLookup: true
    })
  });
})();
