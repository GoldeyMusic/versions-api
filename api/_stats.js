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
 *   - installations RÉELLES du plugin (RPC plugin_install_stats) : un
 *     utilisateur ayant OUVERT le plugin (table plugin_first_seen), décliné
 *     par plateforme de téléchargement (Mac / Windows, 'unknown' si ouvert
 *     sans download loggé). Même notion que la page /admin Versions — les
 *     téléchargements bruts ne comptent PAS. Équipe interne
 *     (STATS_EXCLUDE_EMAILS) exclue. Daté à first_seen_at.
 *   - installs 7 / 30 derniers jours (par date d'ouverture réelle)
 *   - by_platform : { mac, windows, unknown } (somme == total)
 *   - breakdown quotidien des 90 derniers jours (somme == total)
 *   - total inscrits (auth.users via GoTrue admin API, header x-total-count)
 *
 * Revenus (carte MRR global du cockpit — ajout 2026-07-28) :
 *   - mrr_eur : revenu récurrent mensuel = somme des abonnements Stripe
 *     ACTIFS ramenée au mois (annuel → prix/12). Lu en direct depuis l'API
 *     Stripe (source de vérité, pas revenue_logs qui ne déduit pas les
 *     remboursements). Un abo en cancel_at_period_end reste compté tant
 *     qu'il n'est pas terminé (il paie jusqu'à la fin de période).
 *   - sales_30d_eur / sales_30d_count : ventes one-shot (packs) des 30
 *     derniers jours = charges Stripe hors facture d'abo (charge.invoice
 *     null), NETTES des remboursements (amount - amount_refunded ; une
 *     commande intégralement remboursée ne compte ni en € ni en nombre).
 *   Convention montants : TTC — montants réellement encaissés côté client
 *   (automatic_tax désactivé sur le checkout, pas de TVA collectée à part).
 *   Équipe interne (STATS_EXCLUDE_EMAILS) exclue des deux métriques, via
 *   l'email du customer Stripe.
 *   Champs OPTIONNELS côté cockpit : si l'appel Stripe échoue (clé absente,
 *   panne), on les OMET du JSON au lieu d'envoyer des zéros faux — les
 *   stats plugin existantes restent servies normalement.
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const { getStripe } = require('../lib/stripe');

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

// ─── Helpers revenus (Stripe direct) ─────────────────────────────

function isInternalEmail(email) {
  return !!email && STATS_EXCLUDE_EMAILS.includes(String(email).toLowerCase());
}

// MRR en euros TTC : somme des abos actifs ramenée au mois.
// Auto-pagination stripe-node (`for await`) — volume abos très faible,
// mais on reste correct au-delà de 100.
async function computeMrrEur() {
  const stripe = getStripe();
  let mrrCents = 0;
  for await (const sub of stripe.subscriptions.list({
    status: 'active',
    limit: 100,
    expand: ['data.customer'],
  })) {
    const email = (sub.customer && typeof sub.customer === 'object')
      ? sub.customer.email
      : null;
    if (isInternalEmail(email)) continue;

    for (const item of (sub.items && sub.items.data) || []) {
      const price = item.price;
      if (!price || price.currency !== 'eur' || typeof price.unit_amount !== 'number') continue;
      const qty = item.quantity || 1;
      const rec = price.recurring || {};
      const ic = rec.interval_count || 1;
      let monthlyCents = null;
      if (rec.interval === 'month') monthlyCents = (price.unit_amount * qty) / ic;
      else if (rec.interval === 'year') monthlyCents = (price.unit_amount * qty) / (12 * ic);
      else if (rec.interval === 'week') monthlyCents = (price.unit_amount * qty * 52) / (12 * ic);
      else if (rec.interval === 'day') monthlyCents = (price.unit_amount * qty * 365) / (12 * ic);
      if (monthlyCents !== null) mrrCents += monthlyCents;
    }
  }
  return Math.round(mrrCents) / 100;
}

// Ventes one-shot 30 jours : charges Stripe réussies HORS factures d'abo
// (charge.invoice non null = paiement d'abonnement, déjà couvert par le
// MRR), nettes des remboursements partiels ou totaux.
async function computeSales30d() {
  const stripe = getStripe();
  const since = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
  let netCents = 0;
  let count = 0;
  for await (const ch of stripe.charges.list({ created: { gte: since }, limit: 100 })) {
    if (!ch.paid || ch.status !== 'succeeded') continue;
    if (ch.invoice) continue;                 // charge d'abonnement → MRR
    if (ch.currency !== 'eur') continue;
    const email = (ch.billing_details && ch.billing_details.email) || ch.receipt_email || null;
    if (isInternalEmail(email)) continue;
    const net = ch.amount - (ch.amount_refunded || 0);
    if (net <= 0) continue;                   // remboursée intégralement
    netCents += net;
    count += 1;
  }
  return { eur: Math.round(netCents) / 100, count };
}

// ─── GET /downloads ──────────────────────────────────────────────
router.get('/downloads', async (req, res) => {
  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );

    // Installs uniques (RPC — dédup email+plateforme, équipe exclue),
    // total inscrits et revenus Stripe, en parallèle. Les deux appels
    // Stripe sont catchés individuellement : en cas d'échec on renvoie
    // null → champs omis du JSON (le cockpit affiche "en attente"),
    // sans casser les stats plugin.
    const [rpcRes, usersTotal, mrrEur, sales30d] = await Promise.all([
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

      computeMrrEur().catch((e) => {
        console.error('[stats/downloads] computeMrrEur:', e && e.message);
        return null;
      }),

      computeSales30d().catch((e) => {
        console.error('[stats/downloads] computeSales30d:', e && e.message);
        return null;
      }),
    ]);

    if (rpcRes.error) {
      console.error('[stats/downloads] rpc plugin_install_stats:', rpcRes.error.message);
    }
    const s = rpcRes.data || {};

    res.set('Cache-Control', 'public, max-age=300');
    return res.json({
      total: s.total || 0,            // installations réelles (openers × plateforme, hors équipe)
      total_users: usersTotal,
      last_7_days: s.last_7_days || 0,
      last_30_days: s.last_30_days || 0,
      by_platform: s.by_platform || { mac: 0, windows: 0, unknown: 0 },
      daily: s.daily || [],
      // Revenus (euros TTC, nets de remboursements, équipe exclue).
      // Champs optionnels : omis si l'appel Stripe a échoué.
      ...(typeof mrrEur === 'number' ? { mrr_eur: mrrEur } : {}),
      ...(sales30d ? {
        sales_30d_eur: sales30d.eur,
        sales_30d_count: sales30d.count,
      } : {}),
    });
  } catch (err) {
    console.error('[stats/downloads] error:', err && err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
