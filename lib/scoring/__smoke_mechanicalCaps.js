// Smoke test mechanicalCaps — rejoue le benchmark 9 titres du 2026-05-20.
// Usage : node lib/scoring/__smoke_mechanicalCaps.js
//
// Verifie que les caps reagissent comme attendu sur la calibration de
// reference. A relancer apres toute modif des seuils dans mechanicalCaps.js.

const { applyMechanicalCaps } = require('./mechanicalCaps');

const cases = [
  // Démos — caps DOIVENT firer sur 2/3
  { name: 'concert andrea (live)',    mix: true,  raw: 82, expectedCap: 75,  sig: { mCorr: 0.976, mLra: 5.5, mTruePeak: -0.7, voiceVsInstruDelta: 8.2, sibilantsBand: -46.1 } },
  { name: 'jazz instru',              mix: true,  raw: 82, expectedCap: 70,  sig: { mCorr: 0.62,  mLra: 1.4, mTruePeak: -5 } },
  { name: 'maquette nil',             mix: true,  raw: 84, expectedCap: null, sig: { mCorr: 0.822, mLra: 7.9, mTruePeak: -1, sibilantsBand: -50.9 } },

  // Pros — caps NE DOIVENT PAS firer
  { name: 'Polaroids',                mix: true,  raw: 76, expectedCap: null, sig: { mCorr: 0.674, mLra: 4.8, mTruePeak: -0.2 } },
  { name: 'Between us',               mix: true,  raw: 78, expectedCap: null, sig: { mCorr: 0.882, mLra: 5,   mTruePeak: -3.1 } },
  { name: 'Lacher prise',             mix: true,  raw: 86, expectedCap: null, sig: { mCorr: 0.78,  mLra: 4.1, mTruePeak: -0.6, sibilantsBand: -32.6 } },

  // Hits — caps NE DOIVENT PAS firer (LRA bas est normal en master)
  { name: 'Chic Le Freak (master)',   mix: false, raw: 92, expectedCap: null, sig: { mCorr: 0.868, mLra: 2.7, mTruePeak: -0.4 } },
  { name: 'APT (master)',             mix: false, raw: 88, expectedCap: null, sig: { mCorr: 0.726, mLra: 3.5, mTruePeak: -4 } },
  { name: 'Fire through rain (mst)',  mix: false, raw: 87, expectedCap: null, sig: { mCorr: 0.738, mLra: 8.1, mTruePeak: -5.2, sibilantsBand: -39.4 } },
];

console.log('titre                          raw  ->  final  caps                         OK?');
console.log('─'.repeat(95));

let pass = 0;
let fail = 0;
for (const c of cases) {
  const fiche = { globalScore: c.raw };
  const { fiche: out, capsApplied } = applyMechanicalCaps(fiche, c.sig, c.mix ? 'mix' : 'master');
  const keys = capsApplied.map((x) => x.key + '(' + x.cap + ')').join(', ') || '—';
  const actualCap = capsApplied.length ? Math.min(...capsApplied.map((x) => x.cap)) : null;
  const ok = actualCap === c.expectedCap;
  if (ok) pass++; else fail++;
  console.log(
    c.name.padEnd(32),
    String(c.raw).padStart(3),
    ' -> ',
    String(out.globalScore).padStart(3),
    ' ',
    keys.padEnd(28),
    ok ? 'OK' : `KO (expected cap=${c.expectedCap}, got ${actualCap})`
  );
}

console.log('─'.repeat(95));
console.log(`PASS ${pass} / FAIL ${fail}`);
process.exit(fail > 0 ? 1 : 0);
