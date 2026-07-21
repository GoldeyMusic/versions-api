/**
 * api/_stats.js — stats publiques plugin (dashboard Archipel fondateurs).
 *
 * Route :
 *   GET /api/stats/downloads?token=XXX
 *
 * Auth :
 *   Query param `token` comparé à process.env.STATS_TOKEN.
 *   Fail-closed si STATS_TOKEN non configuré (403).
 *
 * CORS :
 *   Autorise archipelaudio.com (le dashboard fondateurs y fetch ces stats).
 *   Ce router est monté AVANT le CORS global dans server.js — sinon le
 *   middleware cors() rejette l'origine avant même que la route ne soit
 *   atteinte.
 *
 * Cache :
 *   Cache-Control: public, max-age=300 (5 minutes).
 *
 * Données (le champ JSON `total` reste nommé `total` pour compat cockpit) :
 *   - installations UNIQUES du plugin (RPC plugin_install_stats) : un couple
 *     (email, plateforme) daté à sa 1re occurrence. Les ré-installs et les
 *     mises à jour (même email+plateforme) ne comptent qu'une fois ; le
 *     multi-plateforme (Mac + PC) compte deux installs ; l'équipe interne
 *     (STATS_EXCLUDE_EMAILS) est exclue de tous les totaux.
 *   - installs uniques 7 / 30 derniers jours (par date de 1re install)
 *   - breakdown quotidien des 90 derniers jours (installs, somme == total)
 *   - total inscrits (auth.users via GoTrue admin API, header x-total-count)
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

// ─── CORS archipelaudio.com ──────────────────────────────────────
const STATS_ORIGINS = [
  'https://archipelaudio.com',
  'https://www.archipelaudio.com',
  'http://localhost:5173',
  'http://localhost:3000',
];

// ─── Emails internes (équipe) exclus des installs uniques ────────
// Surchargeable via STATS_EXCLUDE_EMAILS (CSV). Défaut = fondateurs, pour
// que l'exclusion fonctionne sans variable d'env à configurer sur Railway.
const STATS_EXCLUDE_EMAILS = (process.env.STATS_EXCLUDE_EMAILS
  ? process.env.STATS_EXCLUDE_EMAILS.split(',')
  : ['berdugo.david@gmail.com', 'davidabakan@gmail.com'])
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

router.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && STATS_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Auth token statique ─────────────────────────────────────────
function requireStatsToken(req, res, next) {
  const want = process.env.STATS_TOKEN;
  if (!want) {
    console.error('[stats] STATS_TOKEN not configured on server');
    return res.status(403).json({ error: 'stats_token_not_configured' });
  }
  const got = req.query.token;
  if (!got || got !== want) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

router.use(requireStatsToken);

// ─── GET /downloads ──────────────────────────────────────────────
router.get('/downloads', async (req, res) => {
  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // Installs uniques (RPC — dédup email+plateforme, équipe exclue) et
    // total inscrits, en parallèle.
    const [rpcRes, usersTotal] = await Promise.all([
      sb.rpc('plugin_install_stats', { exclude_emails: STATS_EXCLUDE_EMAILS }),

      // Total inscrits via GoTrue admin API. ⚠️ Le nombre total est renvoyé
      // dans le header HTTP `x-total-count`, PAS dans le body (qui ne
      // contient que le tableau `users`). per_page=1 → on ne charge pas la
      // liste, seul le header nous intéresse. (Ne pas passer par
      // sb.auth.admin.listUsers : cette lib n'expose `total` que si un header
      // Link de pagination est présent — piège silencieux.)
      fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1`, {
        headers: {
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        },
      }).then((r) => Number(r.headers.get('x-total-count')) || 0),
    ]);

    if (rpcRes.error) {
      console.error('[stats/downloads] rpc plugin_install_stats:', rpcRes.error.message);
    }
    const s = rpcRes.data || {};

    res.set('Cache-Control', 'public, max-age=300');
    return res.json({
      total: s.total || 0,            // installations uniques (hors équipe)
      total_users: usersTotal,
      last_7_days: s.last_7_days || 0,
      last_30_days: s.last_30_days || 0,
      daily: s.daily || [],
    });
  } catch (err) {
    console.error('[stats/downloads] error:', err && err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
