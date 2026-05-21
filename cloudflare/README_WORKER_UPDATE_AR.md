تحديث Worker المطلوب لشاشة العرض

افتح Cloudflare > Workers & Pages > taif-cloudflare-api > Edit code.

استبدل كود Worker الحالي كاملًا بمحتوى الملف:

cloudflare/worker.js

ثم اضغط Deploy.

هذا التحديث يضيف endpoint قراءة عام فقط:

/api/rpc/taif_public_price_display_state

هذا endpoint لا يعدّل أي بيانات، ويقرأ فقط حالة العملات من Cloudflare D1.
