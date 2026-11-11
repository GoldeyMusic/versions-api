#!/usr/bin/env node
/**
 * scripts/init_stripe_catalog.js
 *
 * Crée (ou met à jour) les 4 produits + prices Stripe pour Versions :
 *   - 2 packs one-shot (pack_1, pack_5)
 *   - 2 abos mensuels (sub_indie, sub_pro)
 *
 * Catalogue révisé 2026-04-29 (Piste A) : pack_10 / pack_25 / pack_50 retirés.
 * Pour archiver les anciens prices côté Stripe : `node scripts/archive_legacy_packs.js`.
 *
 * Idempotent : si un product existe déjà avec le même metadata.plan_key,
 * on l'utilise au lieu d'en créer un nouveau (évite les doublons en cas
 * de re-run). Les prices, eux, sont créés à chaque run avec un nouveau
 * Price ID Stripe — c'est la convention Stripe (les prices sont immuables).
 *
 * Usage :
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/init_stripe_catalog.js
 *
 * Sortie :
 *   - Une liste de variables d'env Vite à copier dans .env du front
 *     (et dans Vercel pour la prod)
 *   - Récap créé / mis à jour
 *
 * IMPORTANT :
 *   - Lance d'abord en TEST MODE (sk_test_...) pour valider.
 *   - Pour la prod, relance avec sk_live_... (les Price IDs seront différents).
 */

const Stripe = require('stripe');
// Charge .env.bench (gitignoré) si présent : permet de poser
// STRIPE_SECRET_KEY dans ce fichier plutôt que sur la ligne de commande.
try { require('./_benchEnv').loadEnvFile(); } catch (_) { /* optionnel */ }

// ─── Catalogue à synchroniser avec versions-app/src/constants/plans.js ───
// Grille 2026-11-06 (audit) : Solo 6,99 €/4 analyses, Pack Projet 6 analyses
// 14,99 € (remplace Pack 5 — à archiver dans Stripe, cf. archive_legacy_packs.js).
// Pack 1 conservé comme « une analyse de plus », plus en vitrine.
const PACKS = [
  { key: 'pack_1',  name: 'Versions — 1 analyse',           price_eur: 4.99,   credits: 1 },
  { key: 'pack_6',  name: 'Versions — Pack Projet (6)',     price_eur: 14.99,  credits: 6 },
];
const SUBSCRIPTIONS = [
  { key: 'sub_solo',  name: 'Versions — Abo Solo',  price_eur: 6.99,  credits: 4 },
  { key: 'sub_indie', name: 'Versions — Abo Indie', price_eur: 14.99, credits: 12 },
  { key: 'sub_pro',   name: 'Versions — Abo Pro',   price_eur: 29.99, credits: 30 },
];

// Abonnements ANNUELS (2026-11-11) : un 2e prix récurrent "year" posé sur
// le MÊME produit Stripe que le mensuel (lookup par metadata.plan_key =
// baseKey). 2 mois offerts. metadata.credits = enveloppe MENSUELLE : la 1re
// est livrée par invoice.paid, les 11 suivantes par la tâche quotidienne
// grant_annual_monthly_credits() (migration 059).
// `key` ne sert qu'au filtre --only et au nom de la variable d'env ; le
// plan_key écrit dans Stripe reste baseKey (sub_solo / sub_indie / sub_pro).
const ANNUAL_SUBSCRIPTIONS = [
  { key: 'sub_solo_year',  baseKey: 'sub_solo',  name: 'Versions — Abo Solo',  price_eur: 69,  credits: 4 },
  { key: 'sub_indie_year', baseKey: 'sub_indie', name: 'Versions — Abo Indie', price_eur: 149, credits: 12 },
  { key: 'sub_pro_year',   baseKey: 'sub_pro',   name: 'Versions — Abo Pro',   price_eur: 299, credits: 30 },
];

const KEY_TO_ENV = {
  pack_1:    'VITE_STRIPE_PRICE_PACK_1',
  pack_6:    'VITE_STRIPE_PRICE_PACK_6',
  sub_solo:  'VITE_STRIPE_PRICE_SUB_SOLO',
  sub_indie: 'VITE_STRIPE_PRICE_SUB_INDIE',
  sub_pro:   'VITE_STRIPE_PRICE_SUB_PRO',
  sub_solo_year:  'VITE_STRIPE_PRICE_SUB_SOLO_YEAR',
  sub_indie_year: 'VITE_STRIPE_PRICE_SUB_INDIE_YEAR',
  sub_pro_year:   'VITE_STRIPE_PRICE_SUB_PRO_YEAR',
};

(async () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('STRIPE_SECRET_KEY missing.');
    console.error('Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/init_stripe_catalog.js');
    process.exit(1);
  }
  const stripe = new Stripe(key, { appInfo: { name: 'Versions init script', version: '1.0.0' } });

  const isTest = key.startsWith('sk_test_');
  console.log(`\n→ Mode : ${isTest ? 'TEST' : 'LIVE'}\n`);

  const envLines = [];

  // --only pack_6,sub_solo : ne crée QUE ces plans (les prices ne sont pas
  // idempotents : relancer le script sans --only créerait des doublons de
  // prix pour pack_1 / sub_indie / sub_pro déjà en prod).
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.slice(7).split(',').map((x) => x.trim()).filter(Boolean)) : null;
  const wanted = (plan) => !only || only.has(plan.key);
  if (only) console.log(`→ Seulement : ${[...only].join(', ')}\n`);

  // ── Packs ────
  for (const p of PACKS.filter(wanted)) {
    const product = await getOrCreateProduct(stripe, p);
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: Math.round(p.price_eur * 100),
      currency: 'eur',
      metadata: {
        plan_key: p.key,
        credits: String(p.credits),
      },
      nickname: `${p.name} — one-shot`,
    });
    console.log(`✓ ${p.key.padEnd(10)} → ${price.id}`);
    envLines.push(`${KEY_TO_ENV[p.key]}=${price.id}`);
  }

  // ── Abos ────
  for (const sub of SUBSCRIPTIONS.filter(wanted)) {
    const product = await getOrCreateProduct(stripe, sub);
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: Math.round(sub.price_eur * 100),
      currency: 'eur',
      recurring: { interval: 'month' },
      metadata: {
        plan_key: sub.key,
        credits: String(sub.credits),
      },
      nickname: `${sub.name} — monthly`,
    });
    console.log(`✓ ${sub.key.padEnd(10)} → ${price.id}`);
    envLines.push(`${KEY_TO_ENV[sub.key]}=${price.id}`);
  }

  // ── Abos annuels ────
  for (const sub of ANNUAL_SUBSCRIPTIONS.filter(wanted)) {
    const product = await getOrCreateProduct(stripe, { ...sub, key: sub.baseKey });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: Math.round(sub.price_eur * 100),
      currency: 'eur',
      recurring: { interval: 'year' },
      metadata: {
        plan_key: sub.baseKey,
        credits: String(sub.credits),
        billing_interval: 'year',
      },
      nickname: `${sub.name} — yearly`,
    });
    console.log(`✓ ${sub.key.padEnd(14)} → ${price.id}`);
    envLines.push(`${KEY_TO_ENV[sub.key]}=${price.id}`);
  }

  // ── Sortie ────
  console.log('\n=== Variables d\'env à copier ===');
  console.log('# Versions-app (.env local + Vercel) :');
  for (const line of envLines) console.log(line);
  console.log('\n# Versions-api (Railway) : si STRIPE_PRICE_WHITELIST est définie, y AJOUTER :');
  console.log(envLines.map((l) => l.split('=')[1]).join(','));
  console.log('\n=== Étapes restantes ===');
  console.log('1. Colle les VITE_STRIPE_PRICE_* dans versions-app/.env (et Vercel env vars).');
  console.log('2. Crée le webhook Stripe (dashboard) → endpoint https://<versions-api>/api/billing/webhook');
  console.log('   Events à écouter : checkout.session.completed, invoice.paid, customer.subscription.deleted');
  console.log('3. Copie le Webhook signing secret (whsec_...) → STRIPE_WEBHOOK_SECRET sur versions-api.');
  console.log('4. Set STRIPE_SECRET_KEY (sk_test_...) côté versions-api.');
  console.log('\nTerminé.\n');
})().catch((err) => {
  console.error('FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});

// Cherche un product existant par metadata.plan_key (idempotence du re-run).
// Si trouvé, met à jour son name. Sinon, le crée.
async function getOrCreateProduct(stripe, plan) {
  // Stripe permet de filtrer products par metadata via search (latest API)
  const search = await stripe.products.search({
    query: `metadata['plan_key']:'${plan.key}' AND active:'true'`,
    limit: 1,
  });
  if (search.data.length > 0) {
    const found = search.data[0];
    if (found.name !== plan.name) {
      await stripe.products.update(found.id, { name: plan.name });
    }
    return found;
  }
  return await stripe.products.create({
    name: plan.name,
    metadata: { plan_key: plan.key, credits: String(plan.credits) },
  });
}
