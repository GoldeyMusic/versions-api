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
 * Données :
 *   - total téléchargements plugin (table plugin_downloads)
 *   - téléchargements 7 / 30 derniers jours
 *   - breakdown quotidien des 90 derniers jours
 *   - total inscrits (auth.users via GoTrue admin API)
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

    const now = new Date();
    const isoAgo = (n) => {
      const d = new Date(now);
      d.setDate(d.getDate() - n);
      return d.toISOString();
    };

    // Toutes les queries en parallèle
    const [totalRes, last7Res, last30Res, dailyRes, usersTotal] = await Promise.all([
      // Total downloads (count only, no data)
      sb.from('plugin_downloads').select('id', { count: 'exact', head: true }),

      // Last 7 days
      sb.from('plugin_downloads')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', isoAgo(7)),

      // Last 30 days
      sb.from('plugin_downloads')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', isoAgo(30)),

      // Daily breakdown — on ramène les timestamps bruts (90 jours max
      // = quelques centaines de lignes au pire, acceptable).
      sb.from('plugin_downloads')
        .select('created_at')
        .gte('created_at', isoAgo(90))
        .order('created_at', { ascending: true }),

      // Total inscrits via GoTrue admin API. ⚠️ Le nombre total est
      // renvoyé dans le header HTTP `x-total-count`, PAS dans le body (qui
      // ne contient que le tableau `users`). per_page=1 → on ne charge pas
      // la liste, seul le header nous intéresse. (Ne pas passer par
      // sb.auth.admin.listUsers : cette lib n'expose `total` que si un
      // header Link de pagination est présent — piège silencieux.)
      fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=1`, {
        headers: {
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        },
      }).then((r) => Number(r.headers.get('x-total-count')) || 0),
    ]);

    // ── Build daily map (90 jours, pré-rempli à 0) ──────────────
    const dailyMap = {};
    for (let i = 89; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      dailyMap[d.toISOString().slice(0, 10)] = 0;
    }
    if (dailyRes.data) {
      for (const row of dailyRes.data) {
        const day = row.created_at.slice(0, 10);
        if (dailyMap[day] !== undefined) dailyMap[day]++;
      }
    }

    const daily = Object.entries(dailyMap).map(([date, count]) => ({ date, count }));

    res.set('Cache-Control', 'public, max-age=300');
    return res.json({
      total: totalRes.count || 0,
      total_users: usersTotal,
      last_7_days: last7Res.count || 0,
      last_30_days: last30Res.count || 0,
      daily,
    });
  } catch (err) {
    console.error('[stats/downloads] error:', err && err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
