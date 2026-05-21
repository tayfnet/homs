شاشة العرض المستقلة — نسخة Cloudflare D1 الجديدة

هذه النسخة لم تعد تستخدم قاعدة البيانات القديمة نهائيًا.
تم حذف ملفات وتعليمات ومفاتيح قاعدة البيانات القديمة بالكامل من شاشة العرض.

طريقة العمل الجديدة:

- شاشة العرض تقرأ فقط من Cloudflare Worker:
  https://taif-cloudflare-api.mhmadsayf.workers.dev

- الـ Worker يقرأ حالة العملات من Cloudflare D1 من جدول:
  taif_domain_state

- مفتاح حالة العملات المستخدم:
  taif-currency-management-module-v1

ملفات الربط المهمة داخل شاشة العرض:

1) js/config.js
   يحتوي رابط Worker وإعدادات القراءة.

2) js/public-price-display-app.js
   يطلب الأسعار من endpoint:
   /api/rpc/taif_public_price_display_state

مهم جدًا قبل رفع شاشة العرض:

يجب تحديث كود Worker الحالي taif-cloudflare-api بالكود الموجود داخل هذا الملف:

cloudflare/worker.js

لأن هذا التحديث يضيف endpoint عام للقراءة فقط خاص بشاشة العرض:

taif_public_price_display_state

بعد تحديث Worker، ارفع ملفات شاشة العرض على Cloudflare Pages أو أي استضافة Static.

اختبار سريع بعد فتح شاشة العرض:

افتح Console داخل المتصفح وشغّل:

window.TAIF?.publicPriceDisplay?.diagnostics?.()

إذا ظهر:
initialized: true

فهذا يعني أن شاشة العرض قرأت بيانات الأسعار من Cloudflare D1 بنجاح.

ملاحظات:

- شاشة العرض لا تحفظ ولا تعدّل أي بيانات.
- التحديث يتم عبر Poll كل 5 ثواني من Cloudflare Worker.
- لا يوجد أي اتصال مباشر مع D1 من المتصفح؛ الاتصال دائمًا عبر Worker.
- إذا غيّرت أسعار العملات من مشروع TAIF الرئيسي، ستظهر في شاشة العرض بعد ثوانٍ قليلة.
