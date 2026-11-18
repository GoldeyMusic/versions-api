// Test local du détail des ventes (api/_stats.js) avec un faux Stripe :
//   node scripts/test_stats_sales.js
// Aucun réseau, aucune clé. Couvre : abonnement mensuel / annuel (prix sur
// la ligne ou repli au montant), pack, remboursement partiel et total,
// équipe exclue, charge échouée, autre devise, vente hors 90 j comptée dans
// le CA total mais pas dans la liste, série quotidienne de 90 jours.
process.env.STATS_EXCLUDE_EMAILS = 'interne@example.com';
const assert = require('assert');
const { _test } = require('../api/_stats.js');

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);
const t = (daysAgo) => Math.floor((NOW - daysAgo * 86400000) / 1000);
const sub = (key, interval, amount, daysAgo, extra = {}) => ({
  paid: true, status: 'succeeded', currency: 'eur', amount, amount_refunded: 0,
  created: t(daysAgo), billing_details: { email: 'a@example.com' },
  invoice: { lines: { data: [{ metadata: { plan_key: key },
    price: interval ? { recurring: { interval } } : null }] } },
  ...extra,
});
const pack = (key, amount, daysAgo, extra = {}) => ({
  paid: true, status: 'succeeded', currency: 'eur', amount, amount_refunded: 0,
  created: t(daysAgo), billing_details: { email: 'b@example.com' }, invoice: null,
  payment_intent: { metadata: { plan_key: key } }, ...extra,
});

const charges = [
  sub('sub_solo', 'month', 699, 1),
  sub('sub_pro', 'year', 29900, 2),
  sub('sub_indie', null, 14900, 3),                              // annuel deviné au montant
  pack('pack_6', 1499, 0),
  pack('pack_1', 499, 5, { amount_refunded: 200 }),              // remboursé en partie : 2,99
  pack('pack_1', 499, 6, { amount_refunded: 499 }),              // remboursé : ignoré
  pack('pack_6', 1499, 7, { billing_details: { email: 'Interne@example.com' } }), // équipe
  pack('pack_6', 1499, 8, { status: 'failed', paid: false }),    // échec
  pack('pack_6', 1499, 9, { currency: 'usd' }),                  // autre devise
  pack('pack_5', 1999, 200),                                     // hors 90 j : CA total seulement
];
const fakeStripe = { charges: { list: (opts) => {
  assert.deepStrictEqual(opts.expand, ['data.invoice', 'data.payment_intent']);
  return (async function* () { yield* charges; })();
} } };

(async () => {
  const r = await _test.computeSalesDetail(fakeStripe, NOW);
  assert.strictEqual(r.ca_total_eur, 492.96);
  assert.deepStrictEqual(r.sales_list.map((s) => [s.offre, s.montant_eur, s.type]), [
    ['Pack Projet', 14.99, 'achat'],
    ['Solo', 6.99, 'abonnement'],
    ['Pro (annuel)', 299, 'abonnement'],
    ['Indie (annuel)', 149, 'abonnement'],
    ['1 analyse', 2.99, 'achat'],
  ]);
  assert.ok(r.sales_list.every((s) => s.email !== 'Interne@example.com'));
  assert.strictEqual(r.daily_sales_90d.length, 90);
  assert.strictEqual(r.daily_sales_90d[89].date, '2026-11-18');
  assert.deepStrictEqual(r.daily_sales_90d[89], { date: '2026-11-18', count: 1, eur: 14.99 });
  assert.strictEqual(r.daily_sales_90d.reduce((a, d) => a + d.count, 0), 5);

  const s = _test.dailySignups90d([
    { created_at: '2026-11-18T08:00:00Z' }, { created_at: '2026-11-18T09:00:00Z' },
    { created_at: '2026-11-10T10:00:00Z' }, { created_at: '2025-01-01T00:00:00Z' }, {},
  ], NOW);
  assert.strictEqual(s.length, 90);
  assert.deepStrictEqual(s[89], { date: '2026-11-18', count: 2 });
  assert.strictEqual(s.reduce((a, d) => a + d.count, 0), 3);
  console.log('✓ détail des ventes et inscriptions par jour : OK');
})().catch((e) => { console.error(e); process.exit(1); });
