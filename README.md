<div dir="rtl" style="text-align: right;">

# Stylebox Price Sync

![version](https://img.shields.io/badge/version-v1.4.0-blue)

مزامنة أسعار المنتجات بين Shopify وWooCommerce (stylebox.online) —
ويبهوك تلقائي + مزامنة شاملة يدوية. تفاصيل كاملة في `CLAUDE.md`.

```
الواجهة    : https://ecommoda-dev.github.io/Stylebox-Price-Sync/
الـ Worker : https://stylebox-price-sync-worker.ecommoda-dev.workers.dev
```

| الملف | إيه ده |
|---|---|
| `index.js` | كود الـ Worker (مستقبِل الويبهوك + المزامنة الشاملة + السجل) |
| `index.html` | الواجهة (GitHub Pages) — مراقبة السجل وتشغيل المزامنة الشاملة |
| `wordpress/variation-prices-snippet.php` | سنيپت WPCode لـ endpoint الدفعات على stylebox.online (بيتلصق **قبل** نشر الـ Worker) |
| `wrangler.toml` | إعدادات النشر + الـ `[vars]` |
| `CLAUDE.md` | المرجع الكامل: الـ endpoints · D1 · الفخاخ · بصمة المهارات |

آخر تحديث: 20-11-2026 — 00:19

</div>
