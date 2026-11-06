/**
 * lib/credits.js — helpers Supabase pour la mécanique de crédits.
 *
 * Ces helpers sont utilisés :
 *   - par api/billing.js (webhook Stripe) → crédite après paiement
 *   - par api/analyze.js (pipeline) → débit au start, refund à l'erreur
 *
 * Ils s'appuient sur les tables user_credits + credit_events
 * (migration 016 + 020) et utilisent le service_role pour bypasser RLS.
 *
 * Modèle de crédits (révision 2026-04-29, modèle Splice) :
 *   - 2 buckets : subscription_balance (purgeable à résiliation) et
 *     pack_balance (à vie). Mirror agrégé dans balance_remaining.
 *   - Les crédits abo se cumulent tant que l'abo est actif (pas de reset
 *     mensuel). Purgés à customer.subscription.deleted.
 *   - Au débit, on consomme sub d'abord, puis pack (RPC debit_credits_ordered).
 *
 * Pendant la phase test, le pipeline analyze.js peut choisir de NE PAS
 * débiter (toggle MONETIZATION_ENABLED). Stripe webhooks, eux, sont
 * actifs dès qu'ils reçoivent un événement.
 */

const { createClient } = require('@supabase/supabase-js');

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — credits helpers unavailable');
  }
  _supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabase;
}

/**
 * Mapping reason → bucket par défaut. Utilisé si le caller ne précise pas.
 */
const REASON_TO_BUCKET = {
  signup_bonus: 'pack',
  purchase_pack: 'pack',
  manual_admin: 'pack',
  seed_test_phase: 'pack',
  subscription_grant: 'sub',
  subscription_reset: 'sub',
  // Pour debit_analysis et refund_failed, on ne passe normalement PAS par
  // applyCreditDelta directement (on utilise debitOrdered). Si on le fait
  // quand même (ex: refund après débit ordonné), bucket='pack' par défaut.
  debit_analysis: 'pack',
  refund_failed: 'pack',
};

/**
 * Lit le solde courant. Crée la ligne user_credits si absente (avec 0).
 * Renvoie { balance, subscription, pack } ou null si user_id invalide.
 */
async function getBalance(userId) {
  if (!userId) return null;
  const sb = getSupabase();
  await sb.from('user_credits')
    .upsert({ user_id: userId, balance_remaining: 0 }, { onConflict: 'user_id', ignoreDuplicates: true });
  const { data, error } = await sb
    .from('user_credits')
    .select('balance_remaining, subscription_balance, pack_balance')
    .eq('user_id', userId)
    .single();
  if (error) {
    console.error('[credits] getBalance failed:', error.message);
    return null;
  }
  return {
    balance: Number(data?.balance_remaining || 0),
    subscription: Number(data?.subscription_balance || 0),
    pack: Number(data?.pack_balance || 0),
  };
}

/**
 * Applique un mouvement de crédit atomique : INSERT credit_events +
 * UPDATE user_credits sur le bucket spécifié. Retourne le nouveau solde total.
 *
 * Args :
 *   userId          : uuid du user
 *   delta           : signé (+N pour crédit, -N pour débit)
 *   reason          : enum (cf. migration 016 contrainte CHECK)
 *   bucket          : 'sub' | 'pack' — par défaut résolu via REASON_TO_BUCKET
 *   jobId           : analyse associée (optionnel)
 *   stripeEventId   : id event Stripe pour idempotence webhook (UNIQUE)
 *   notes           : texte libre
 *
 * Si stripeEventId est déjà connu, on no-op et on renvoie le balance courant.
 */
async function applyCreditDelta({ userId, delta, reason, bucket, jobId = null, stripeEventId = null, notes = null }) {
  if (!userId) throw new Error('userId required');
  if (!Number.isFinite(delta) || delta === 0) throw new Error('delta must be a non-zero number');
  if (!reason) throw new Error('reason required');

  const targetBucket = bucket || REASON_TO_BUCKET[reason] || 'pack';
  if (targetBucket !== 'sub' && targetBucket !== 'pack') {
    throw new Error(`invalid bucket: ${targetBucket}`);
  }

  const sb = getSupabase();

  // Idempotence pour webhooks Stripe : si l'event est déjà loggé, no-op.
  if (stripeEventId) {
    const { data: existing } = await sb
      .from('credit_events')
      .select('id')
      .eq('stripe_event_id', stripeEventId)
      .maybeSingle();
    if (existing) {
      console.log(`[credits] event ${stripeEventId} already processed, skipping`);
      const cur = await getBalance(userId);
      return cur?.balance ?? 0;
    }
  }

  // Insère l'event d'audit.
  const { error: evErr } = await sb.from('credit_events').insert({
    user_id: userId,
    delta,
    reason,
    job_id: jobId,
    stripe_event_id: stripeEventId,
    notes,
  });
  if (evErr) {
    console.error('[credits] insert event failed:', evErr.message);
    throw new Error(`credit_event insert failed: ${evErr.message}`);
  }

  // S'assure qu'une ligne user_credits existe.
  await sb.from('user_credits')
    .upsert({ user_id: userId, balance_remaining: 0 }, { onConflict: 'user_id', ignoreDuplicates: true });

  // RPC bucket-aware (migration 020).
  const { data, error: upErr } = await sb.rpc('apply_credit_delta_bucketed', {
    target_user_id: userId,
    delta_value: delta,
    target_bucket: targetBucket,
  });
  if (upErr) {
    console.error('[credits] apply_credit_delta_bucketed failed:', upErr.message);
    throw new Error(`balance update failed: ${upErr.message}`);
  }
  const newBalance = Number(data || 0);
  console.log(`[credits] ${userId} ${delta >= 0 ? '+' : ''}${delta} (${reason} → ${targetBucket}) → ${newBalance}`);
  return newBalance;
}

/**
 * Débit ordonné : consomme subscription_balance D'ABORD, puis pack_balance.
 * Utilisé par le pipeline analyze pour le débit -1 au start.
 *
 * Renvoie { ok: true, newBalance, fromSub, fromPack } si OK,
 * { ok: false, reason: 'insufficient_balance', balance } si solde insuffisant.
 *
 * Côté audit : on log un seul credit_event 'debit_analysis' avec delta=-N.
 * Le détail "combien depuis sub vs pack" est calculé ici à partir du
 * solde lu avant l'opération (best-effort, pour audit lisible).
 */
async function debitOrdered({ userId, amount = 1, jobId = null, notes = null }) {
  if (!userId) throw new Error('userId required');
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be a positive number');

  const sb = getSupabase();

  // Lecture du détail avant débit (pour audit). Best-effort, pas verrouillé —
  // la RPC se charge du verrou et de la cohérence transactionnelle.
  const before = await getBalance(userId);
  if (!before || before.balance < amount) {
    return { ok: false, reason: 'insufficient_balance', balance: before?.balance ?? 0 };
  }

  // RPC débit ordonné (migration 020) : consomme sub puis pack en transaction.
  const { data, error } = await sb.rpc('debit_credits_ordered', {
    target_user_id: userId,
    debit_amount: amount,
  });
  if (error) {
    console.error('[credits] debit_credits_ordered failed:', error.message);
    throw new Error(`debit failed: ${error.message}`);
  }
  const newBalance = Number(data ?? -1);
  if (newBalance < 0) {
    // RPC a renvoyé -1 : solde insuffisant détecté côté DB (race avec autre débit).
    return { ok: false, reason: 'insufficient_balance', balance: before.balance };
  }

  const fromSub = Math.min(before.subscription, amount);
  const fromPack = amount - fromSub;

  // Audit trail : un seul event 'debit_analysis' (signé négatif).
  const { error: evErr } = await sb.from('credit_events').insert({
    user_id: userId,
    delta: -amount,
    reason: 'debit_analysis',
    job_id: jobId,
    notes: notes || `Débit ordonné : ${fromSub} sub + ${fromPack} pack`,
  });
  if (evErr) {
    // Le débit a déjà été appliqué côté DB. On log mais on ne throw pas —
    // l'audit trail est désynchro, à surveiller via le sanity-check invariant.
    console.error('[credits] debit_analysis event log failed:', evErr.message);
  }

  console.log(`[credits] ${userId} debit -${amount} (sub=${fromSub} + pack=${fromPack}) → ${newBalance}`);
  return { ok: true, newBalance, fromSub, fromPack };
}

/**
 * Purge le subscription_balance à la résiliation d'un abo
 * (event customer.subscription.deleted). Renvoie le montant purgé,
 * et log un credit_event 'subscription_reset' signé négatif pour audit.
 */
async function purgeSubscriptionBalance({ userId, stripeEventId = null, notes = null }) {
  if (!userId) throw new Error('userId required');

  const sb = getSupabase();

  // Idempotence webhook.
  if (stripeEventId) {
    const { data: existing } = await sb
      .from('credit_events')
      .select('id')
      .eq('stripe_event_id', stripeEventId)
      .maybeSingle();
    if (existing) {
      console.log(`[credits] purge event ${stripeEventId} already processed, skipping`);
      const cur = await getBalance(userId);
      return cur?.balance ?? 0;
    }
  }

  const { data, error } = await sb.rpc('purge_subscription_balance', {
    target_user_id: userId,
  });
  if (error) {
    console.error('[credits] purge_subscription_balance failed:', error.message);
    throw new Error(`purge failed: ${error.message}`);
  }
  const purged = Number(data || 0);

  if (purged > 0) {
    const { error: evErr } = await sb.from('credit_events').insert({
      user_id: userId,
      delta: -purged,
      reason: 'subscription_reset',
      stripe_event_id: stripeEventId,
      notes: notes || 'Résiliation abo : purge subscription_balance',
    });
    if (evErr) {
      console.error('[credits] subscription_reset event log failed:', evErr.message);
    }
  }

  console.log(`[credits] ${userId} subscription purged (${purged} credits removed)`);
  return purged;
}

// Résiliation (tarifs 2026-11-06) : le solde abo non consommé n'est plus
// purgé mais CONVERTI en crédits de grâce valables `graceDays` jours
// (RPC convert_subscription_to_grace, migration 057). Idempotent par
// stripe_event_id. Renvoie le nombre de crédits convertis.
async function convertSubscriptionToGrace({ userId, graceDays = 90, stripeEventId = null, notes = null }) {
  if (!userId) throw new Error('userId required');
  const sb = getSupabase();
  if (stripeEventId) {
    const { data: existing } = await sb
      .from('credit_events')
      .select('id')
      .eq('stripe_event_id', stripeEventId)
      .maybeSingle();
    if (existing) {
      console.log(`[credits] grace-convert event ${stripeEventId} already processed, skipping`);
      return 0;
    }
  }
  const { data, error } = await sb.rpc('convert_subscription_to_grace', {
    target_user_id: userId,
    grace_days: graceDays,
  });
  if (error) {
    console.error('[credits] convert_subscription_to_grace failed:', error.message);
    throw new Error(`grace convert failed: ${error.message}`);
  }
  const moved = Number(data || 0);
  // Marqueur d'idempotence (la RPC journalise déjà la conversion sans event id).
  if (stripeEventId) {
    const { error: evErr } = await sb.from('credit_events').insert({
      user_id: userId,
      delta: 0,
      reason: 'grace_convert',
      stripe_event_id: stripeEventId,
      notes: notes || `Résiliation abo : ${moved} crédits convertis en grâce (${graceDays} j)`,
    });
    if (evErr) console.error('[credits] grace_convert marker failed:', evErr.message);
  }
  console.log(`[credits] ${userId} subscription converted to grace (${moved} credits, ${graceDays} d)`);
  return moved;
}

module.exports = {
  convertSubscriptionToGrace,
  getBalance,
  applyCreditDelta,
  debitOrdered,
  purgeSubscriptionBalance,
};
