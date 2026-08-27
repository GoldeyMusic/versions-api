/**
 * api/_client_error.js — réception des rapports de crash front.
 *
 * Contexte (2026-07-21) : page blanche non diagnosticable chez un
 * utilisateur Windows (verdoljose2) — pas de Sentry, pas de logs client.
 * Le front (src/lib/crashReporter.js + ErrorBoundary de main.jsx) POST ici
 * les erreurs JS globales. On les rend visibles à 3 endroits :
 *   1. Railway logs (console.error → grep [client-error]) ;
 *   2. table Supabase `client_errors` (migration 047) ;
 *   3. notif ops par email, throttlée à 1 par heure (anti-spam).
 *
 * Filtre de bruit tiers (2026-08-27) : miroir du filtre front, cf. isNoise
 * plus bas — les rapports venant de scripts injectés (webview in-app Meta,
 * extensions navigateur) sont jetés avant la base et avant la notif.
 *
 * Endpoint PUBLIC (pas d'auth : le crash peut précéder l'hydratation de la
 * session). Protections : rate-limit IP en mémoire (10/h), payload 8 kb,
 * champs tronqués côté serveur (défense contre un POST forgé).
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { notifyOps, renderOpsEmail } = require('../lib/notifyOps');

const router = express.Router();

// ─── Rate-limit IP simple (en mémoire, fenêtre 1 h) ───────────────
const hits = new Map(); // ip → { count, windowStart }
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 10;
function allow(ip) {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.windowStart > WINDOW_MS) {
    hits.set(ip, { count: 1, windowStart: now });
    return true;
  }
  h.count += 1;
  return h.count <= MAX_PER_WINDOW;
}
// Purge périodique pour ne pas grossir indéfiniment.
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (now - h.windowStart > WINDOW_MS) hits.delete(ip);
}, WINDOW_MS).unref();

// ─── Filtre de bruit tiers (2026-08-27) ───────────────────────────
// Miroir de `src/lib/crashReporter.js` côté front. Pourquoi le dupliquer
// ici alors que le front filtre déjà : le filtre front ne protège que les
// visiteurs qui ont chargé le dernier bundle. Les bundles en cache
// continuent d'envoyer le bruit pendant des jours après un déploiement, et
// rien n'empêche un POST forgé. Ce filtre-ci est la ligne de défense
// finale : ni ligne en base, ni notif ops.
//
// Motifs connus :
//   - webview in-app Meta (pubs Instagram) : pont JS↔Java détruit au swipe
//     de fermeture → "Error invoking postMessage: Java object is gone",
//     stack `iabjs://navigation_performance_logger_android` ;
//   - scripts injectés par WebKit (`webkit-masked-url://hidden/`) :
//     extension Safari ou WKUserScript, WebKit masque l'URL réelle. Vu le
//     2026-08-26 avec "undefined is not an object (evaluating 'e.useCache')"
//     — `useCache` est un interne React 18, notre bundle est en React 19 ;
//   - extensions Chrome/Firefox, erreurs cross-origin anonymisées.
//
// Un vrai crash de notre bundle a une stack qui pointe `/assets/*.js` et
// passe ce filtre sans encombre.
const NOISE_MESSAGES = [
  /java object is gone/i,            // pont JS↔Java WebView détruit
  /error invoking postmessage/i,     // idem, formulation Meta
  /^(uncaught )?script error\.?$/i,  // cross-origin, aucune info
  /resizeobserver loop/i,            // bruit navigateur classique, inoffensif
  /instantsearchsdkjsbridge/i,       // navigateur in-app Bing / Edge
  /vue is not defined|ucbrowser/i,   // navigateurs in-app exotiques
];

const NOISE_STACK = [
  /iabjs:\/\//i,                     // in-app browser Instagram / Facebook
  /fbjs:\/\//i,
  /navigation_performance_logger/i,
  /chrome-extension:\/\//i,          // extensions navigateur
  /moz-extension:\/\//i,
  /safari-(web-)?extension:\/\//i,
  /webkit-masked-url:/i,             // script injecté (extension Safari / WKUserScript)
  /anonymous scripts?/i,
];

function isNoise(message, stack) {
  const m = String(message || '');
  const s = String(stack || '');
  if (NOISE_MESSAGES.some((re) => re.test(m))) return true;
  if (NOISE_STACK.some((re) => re.test(s))) return true;
  return false;
}

// On ne logge pas une ligne Railway par hit de bruit (ça remplacerait un
// spam par un autre) : compteur + résumé 1× par heure, histoire de garder
// une trace si le filtre se met à manger de vrais crashs.
let noiseCount = 0;
let lastNoiseLogMs = 0;

// ─── Throttle notif ops : 1 email max par heure ───────────────────
let lastNotifyMs = 0;

router.post('/', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();

    const b = req.body || {};
    const row = {
      message: String(b.message || 'unknown').slice(0, 500),
      stack: String(b.stack || '').slice(0, 3000),
      source: String(b.source || '').slice(0, 40),
      path: String(b.path || '').slice(0, 300),
      ua: String(b.ua || req.headers['user-agent'] || '').slice(0, 400),
      user_id: typeof b.userId === 'string' && /^[0-9a-f-]{36}$/i.test(b.userId) ? b.userId : null,
      email: String(b.email || '').slice(0, 200) || null,
      ip: ip.slice(0, 60) || null,
    };

    // 0. Bruit tiers : sortie immédiate, AVANT le rate-limit IP — sinon le
    //    bruit consomme les 10 rapports/h d'un utilisateur qui plante vraiment.
    if (isNoise(row.message, row.stack)) {
      noiseCount += 1;
      const nowNoise = Date.now();
      if (nowNoise - lastNoiseLogMs > WINDOW_MS) {
        lastNoiseLogMs = nowNoise;
        console.log(`[client-error] bruit tiers ignoré (${noiseCount} depuis le dernier résumé) · dernier: ${row.message.slice(0, 120)}`);
        noiseCount = 0;
      }
      return res.json({ ok: true, ignored: 'noise' });
    }

    if (!allow(ip)) return res.status(429).json({ ok: false });

    // 1. Railway logs — diagnostic immédiat au grep.
    console.error(`[client-error] ${row.email || row.user_id || ip} · ${row.path} · ${row.ua.slice(0, 80)}\n  ${row.message}\n  ${row.stack.split('\n').slice(0, 4).join('\n  ')}`);

    // 2. Table Supabase (best-effort — un insert raté ne casse pas la réponse).
    try {
      const sb = getSupabase();
      await sb.from('client_errors').insert(row);
    } catch (e) {
      console.warn('[client-error] insert failed:', e.message);
    }

    // 3. Notif ops throttlée.
    const now = Date.now();
    if (now - lastNotifyMs > WINDOW_MS) {
      lastNotifyMs = now;
      await notifyOps({
        subject: `[Versions] Crash front · ${row.email || 'anonyme'}`,
        html: renderOpsEmail({
          title: 'Crash JavaScript côté client',
          intro: 'Le front a rapporté une erreur (throttle 1 email/h — voir la table client_errors pour tout l\'historique).',
          rows: [
            { label: 'Utilisateur', value: row.email || row.user_id || '—' },
            { label: 'Page', value: row.path || '—' },
            { label: 'Navigateur', value: row.ua || '—' },
            { label: 'Source', value: row.source || '—' },
          ],
          blocks: [
            { label: 'Message', body: row.message },
            { label: 'Stack', body: row.stack.split('\n').slice(0, 12).join('\n') },
          ],
        }),
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[client-error] handler failed:', err.message);
    return res.status(500).json({ ok: false });
  }
});

let _sb = null;
function getSupabase() {
  if (_sb) return _sb;
  _sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
  return _sb;
}

module.exports = router;
