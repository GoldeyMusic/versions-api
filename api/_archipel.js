/**
 * api/_archipel.js — ponts serveur à serveur avec Archipel Audio.
 *
 * Route :
 *   POST /api/archipel/optout   body { email }
 *
 * Désinscription centrale (série « nouvelles d'Archipel Audio ») → pose
 * archipel_optout_at (source 'central') sur le compte Versions qui porte
 * cet email (RPC archipel_optout_by_email, migration 052).
 *
 * Auth :
 *   Header `Authorization: Bearer <token>` comparé à
 *   ARCHIPEL_OPTOUT_TOKEN, ou à STATS_TOKEN si la variable dédiée n'est pas
 *   posée (même jeton que le cockpit, autorisé par le mémo du 2026-10-20).
 *   Fail-closed si aucun des deux n'est configuré.
 *
 * Contrat :
 *   - idempotent (la date de la première opposition est conservée) ;
 *   - répond 200 { ok: true } même si l'email est inconnu (ne révèle pas
 *     l'existence d'un compte) ;
 *   - 400 si l'email est absent ou malformé, 403 si jeton invalide.
 *
 * Monté APRÈS express.json() dans server.js. Pas d'Origin (serveur à
 * serveur) → laissé passer par le CORS global.
 */

const crypto = require('crypto');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const router = express.Router();

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requireArchipelToken(req, res, next) {
  const want = process.env.ARCHIPEL_OPTOUT_TOKEN || process.env.STATS_TOKEN;
  if (!want) {
    console.error('[archipel] ARCHIPEL_OPTOUT_TOKEN / STATS_TOKEN not configured');
    return res.status(403).json({ error: 'token_not_configured' });
  }
  const header = req.headers.authorization || '';
  const got = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!got || !safeEqual(got, want)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

router.use(requireArchipelToken);

router.post('/optout', async (req, res) => {
  const raw = req.body && typeof req.body.email === 'string' ? req.body.email : '';
  const email = raw.trim().toLowerCase();
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'invalid_email' });
  }
  try {
    const sb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { error } = await sb.rpc('archipel_optout_by_email', { p_email: email });
    if (error) {
      console.error('[archipel/optout] rpc:', error.message);
      return res.status(500).json({ error: 'internal_error' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[archipel/optout] error:', err && err.message);
    return res.status(500).json({ error: 'internal_error' });
  }
});

module.exports = router;
