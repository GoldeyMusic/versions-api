#!/usr/bin/env node
/**
 * scripts/archive_legacy_packs.js
 *
 * Archive les Price IDs Stripe des packs retirés du catalogue
 * (révision 2026-04-29 — Piste A) : pack_10, pack_25, pack_50.
 *
 * Pourquoi : les abos cannibalisaient ces gros packs (1 mois Pro à 30 €
 * = 30 analyses, contre pack_10 à 35 €). Aucun rationnel ne les achetait.
 *
 * Effet :
 *   - Tous les Prices avec metadata.plan_key = pack_10|pack_25|pack_50 → archive.
 *     Les Prices archivés ne peuvent plus être proposés en Checkout, mais
 *     restent disponibles pour les renouvellements existants (n/a ici puisque
 *     les packs sont one-shot).
 *   - Les Products correspondants → archive aussi (cosmétique, pour ne pas
 *     polluer le dashboard Stripe).
 *
 * Idempotent : ne touche pas aux products/prices déjà archivés.
 *
 * Usage :
 *   STRIPE_SECRET_KEY=sk_test_... node scripts/archive_legacy_packs.js
 *
 * À relancer avec sk_live_... le jour du flip MONETIZATION_ENABLED=true
 * (si pack_10/25/50 ont déjà été créés en mode live ; sinon n/a).
 */

const Stripe = require('stripe');

// pack_5 ajouté le 2026-11-06 : remplacé par pack_6 (Pack Projet 14,99 €).
const LEGACY_PACK_KEYS = ['pack_10', 'pack_25', 'pack_50', 'pack_5'];

(async () => {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error('STRIPE_SECRET_KEY missing.');
    console.error('Usage: STRIPE_SECRET_KEY=sk_test_... node scripts/archive_legacy_packs.js');
    process.exit(1);
  }
  const stripe = new Stripe(key, { appInfo: { name: 'Versions archive script', version: '1.0.0' } });

  const isTest = key.startsWith('sk_test_');
  console.log(`\n→ Mode : ${isTest ? 'TEST' : 'LIVE'}\n`);

  let totalPricesArchived = 0;
  let totalProductsArchived = 0;
  let totalAlreadyArchived = 0;

  for (const planKey of LEGACY_PACK_KEYS) {
    console.log(`\n── ${planKey} ────`);

    // Récupère TOUS les products (actifs ET inactifs) avec ce plan_key
    const productsSearch = await stripe.products.search({
      query: `metadata['plan_key']:'${planKey}'`,
      limit: 10,
    });

    if (productsSearch.data.length === 0) {
      console.log(`  · aucun product trouvé pour ${planKey} — n/a`);
      continue;
    }

    for (const product of productsSearch.data) {
      // Archive les Prices liés à ce product (actifs uniquement)
      const prices = await stripe.prices.list({ product: product.id, active: true, limit: 100 });
      for (const price of prices.data) {
        await stripe.prices.update(price.id, { active: false });
        console.log(`  ✓ price archivé : ${price.id} (${price.unit_amount / 100} ${price.currency.toUpperCase()})`);
        totalPricesArchived++;
      }

      // Archive le Product lui-même (s'il était encore actif)
      if (product.active) {
        await stripe.products.update(product.id, { active: false });
        console.log(`  ✓ product archivé : ${product.id} (${product.name})`);
        totalProductsArchived++;
      } else {
        console.log(`  · product déjà archivé : ${product.id}`);
        totalAlreadyArchived++;
      }
    }
  }

  console.log('\n=== Récap ===');
  console.log(`Prices archivés     : ${totalPricesArchived}`);
  console.log(`Products archivés   : ${totalProductsArchived}`);
  console.log(`Déjà archivés (skip): ${totalAlreadyArchived}`);
  console.log('\nN\'oublie pas de retirer les variables VITE_STRIPE_PRICE_PACK_10/25/50');
  console.log('des env vars Vercel (front + back) si elles y traînent encore.\n');
})().catch((err) => {
  console.error('FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
