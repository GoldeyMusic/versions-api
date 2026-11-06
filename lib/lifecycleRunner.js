/**
 * lib/lifecycleRunner.js — sélection et envoi des emails d'activation
 * (audit 2026-11-05, quick win 7 ; textes dans lib/lifecycleEmails.js).
 *
 * Trois emails, un seul envoi de chacun par utilisateur (table
 * lifecycle_emails_sent, PK user_id+kind, migration 056 versions-app) :
 *
 *   activation_j2 : inscrit depuis ≥ 2 jours, AUCUNE analyse (ni débit de
 *                   crédit, ni version en base) ET aucune écoute express
 *                   plugin (un utilisateur plugin actif n'est pas dormant).
 *   example_j7    : mêmes conditions, inscrit depuis ≥ 7 jours, et
 *                   activation_j2 envoyé depuis ≥ 5 jours (jamais deux
 *                   mails le même jour, y compris pour le rattrapage).
 *   v2_nudge      : première fiche faite depuis ≥ 3 jours, aucun titre
 *                   avec ≥ 2 versions, solde ≥ 1 crédit (à 0 crédit : rien,
 *                   pas de mail commercial déguisé). Cible = le titre à une
 *                   version le plus récent, lien direct vers sa fiche.
 *
 * Exclus partout : équipe (ADMIN_EMAILS newsletter), emails non confirmés.
 * Désinscription : List-Unsubscribe mailto, comme la newsletter — un
 * désabonnement se traite en insérant les 3 kinds dans lifecycle_emails_sent
 * pour cet utilisateur (helper markOptOut).
 *
 * Plafond : `limit` envois par passage (défaut 20) pour lisser le rattrapage
 * des anciens comptes. Ordre de priorité : v2_nudge (le plus chaud), puis
 * activation_j2 (inscrits les plus récents d'abord), puis example_j7.
 *
 * Déclenchement : POST /api/lifecycle/run (api/_lifecycle.js), un passage
 * par jour via cron externe. `dry=1` liste sans envoyer ni journaliser.
 */
const { createClient } = require('@supabase/supabase-js');
const { ADMIN_EMAILS } = require('./newsletter');
const { buildActivationNudgeEmail, buildExampleEmail, buildV2NudgeEmail } = require('./lifecycleEmails');

const DAY = 24 * 60 * 60 * 1000;
const APP_BASE = () => process.env.APP_BASE_URL || 'https://versions.studio';
const RESEND_FROM = () => process.env.RESEND_USER_FROM || 'Versions <contact@versions.studio>';

const KINDS = ['v2_nudge', 'activation_j2', 'example_j7'];

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquantes');
  return createClient(url, key, { auth: { persistSession: false } });
}

function firstName({ prenom, displayName, email }) {
  if (prenom && String(prenom).trim()) return String(prenom).trim();
  if (displayName && String(displayName).trim()) return String(displayName).trim().split(/\s+/)[0];
  if (email) {
    const local = String(email).split('@')[0].split(/[._-]/)[0];
    if (local && /^[a-z]{3,}$/i.test(local)) return local.charAt(0).toUpperCase() + local.slice(1).toLowerCase();
  }
  return null;
}

async function listUsers(sb) {
  const out = [];
  let page = 1;
  const perPage = 200;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const users = data?.users || [];
    for (const u of users) {
      if (!u?.id || !u?.email) continue;
      if (ADMIN_EMAILS.has(u.email.toLowerCase())) continue;
      if (!(u.email_confirmed_at || u.confirmed_at)) continue;
      out.push({
        userId: u.id,
        email: u.email,
        createdAt: new Date(u.created_at).getTime(),
        locale: u.user_metadata?.locale === 'en' ? 'en' : 'fr',
        displayName: u.user_metadata?.full_name || u.user_metadata?.name || null,
        prenom: null,
      });
    }
    if (users.length < perPage) break;
    page += 1;
    if (page > 50) break;
  }
  if (out.length) {
    const { data: profiles } = await sb.from('profiles').select('id, prenom').in('id', out.map((u) => u.userId));
    const byId = new Map((profiles || []).map((p) => [p.id, p.prenom]));
    for (const u of out) u.prenom = byId.get(u.userId) || null;
  }
  return out;
}

// Construit le plan d'envoi : [{ kind, user, payload }] trié par priorité,
// SANS plafond (le plafond s'applique à l'envoi).
async function buildPlan(sb, { now = Date.now() } = {}) {
  const users = await listUsers(sb);
  const ids = users.map((u) => u.userId);
  if (!ids.length) return [];

  const [sentRes, debitRes, versRes, expressRes, creditsRes] = await Promise.all([
    sb.from('lifecycle_emails_sent').select('user_id, kind, sent_at').in('user_id', ids),
    sb.from('credit_events').select('user_id').eq('reason', 'debit_analysis').in('user_id', ids),
    sb.from('versions').select('id, name, created_at, track_id, locale, score:analysis_result->fiche->>globalScore, tracks!inner(id, user_id, title)').in('tracks.user_id', ids),
    sb.from('plugin_express_usage').select('user_id, count').in('user_id', ids),
    sb.from('user_credits').select('user_id, balance_remaining').in('user_id', ids),
  ]);
  for (const r of [sentRes, debitRes, versRes, expressRes, creditsRes]) {
    if (r.error) throw new Error(`select failed: ${r.error.message}`);
  }

  const sent = new Map(); // userId -> Map(kind -> sentAt ms)
  for (const row of sentRes.data || []) {
    if (!sent.has(row.user_id)) sent.set(row.user_id, new Map());
    sent.get(row.user_id).set(row.kind, new Date(row.sent_at).getTime());
  }
  const hasDebit = new Set((debitRes.data || []).map((r) => r.user_id));
  const express = new Set((expressRes.data || []).filter((r) => Number(r.count) > 0).map((r) => r.user_id));
  const credits = new Map((creditsRes.data || []).map((r) => [r.user_id, Number(r.balance_remaining) || 0]));

  // Versions groupées par utilisateur puis par titre.
  const byUser = new Map(); // userId -> Map(trackId -> { title, versions: [] })
  for (const v of versRes.data || []) {
    const uid = v.tracks?.user_id;
    if (!uid) continue;
    if (!byUser.has(uid)) byUser.set(uid, new Map());
    const tracks = byUser.get(uid);
    if (!tracks.has(v.track_id)) tracks.set(v.track_id, { title: v.tracks?.title || '', versions: [] });
    tracks.get(v.track_id).versions.push({
      id: v.id, name: v.name, createdAt: new Date(v.created_at).getTime(),
      locale: v.locale, score: v.score != null ? Number(v.score) : null,
    });
  }

  const plan = [];
  for (const u of users) {
    const age = now - u.createdAt;
    const sentKinds = sent.get(u.userId) || new Map();
    const tracks = byUser.get(u.userId) || new Map();
    const hasAnalysis = hasDebit.has(u.userId) || tracks.size > 0;
    const hasExpress = express.has(u.userId);
    const name = firstName(u);

    if (!hasAnalysis && !hasExpress) {
      if (age >= 2 * DAY && !sentKinds.has('activation_j2')) {
        plan.push({ kind: 'activation_j2', user: u, payload: { locale: u.locale, firstName: name } });
      } else if (age >= 7 * DAY && !sentKinds.has('example_j7') && sentKinds.has('activation_j2')
        && now - sentKinds.get('activation_j2') >= 5 * DAY) {
        plan.push({ kind: 'example_j7', user: u, payload: { locale: u.locale, firstName: name } });
      }
      continue;
    }

    if (tracks.size > 0 && !sentKinds.has('v2_nudge')) {
      const all = [...tracks.entries()];
      const hasMultiVersion = all.some(([, t]) => t.versions.length >= 2);
      const firstVersionAt = Math.min(...all.flatMap(([, t]) => t.versions.map((x) => x.createdAt)));
      const balance = credits.get(u.userId) || 0;
      if (!hasMultiVersion && now - firstVersionAt >= 3 * DAY && balance >= 1) {
        // Titre à une version le plus récent.
        const [trackId, t] = all.sort((a, b) => b[1].versions[0].createdAt - a[1].versions[0].createdAt)[0];
        const v = t.versions[0];
        const locale = v.locale === 'en' || v.locale === 'fr' ? v.locale : u.locale;
        plan.push({
          kind: 'v2_nudge', user: u,
          payload: { locale, firstName: name, title: t.title, score: v.score, ficheUrl: `${APP_BASE()}/fiche/${trackId}/${v.id}` },
        });
      }
    }
  }

  const rank = { v2_nudge: 0, activation_j2: 1, example_j7: 2 };
  plan.sort((a, b) => (rank[a.kind] - rank[b.kind]) || (b.user.createdAt - a.user.createdAt));
  return plan;
}

function buildEmail(kind, payload) {
  if (kind === 'activation_j2') return buildActivationNudgeEmail(payload);
  if (kind === 'example_j7') return buildExampleEmail(payload);
  if (kind === 'v2_nudge') return buildV2NudgeEmail(payload);
  throw new Error(`kind inconnu: ${kind}`);
}

async function sendViaResend({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: 'resend_api_key_missing' };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM(), to: [to], subject, html,
        headers: { 'List-Unsubscribe': '<mailto:contact@versions.studio?subject=Désabonnement emails Versions>' },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[lifecycle] resend failed:', res.status, body.slice(0, 200));
      return { ok: false, error: `resend_${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Passage du cron. Renvoie { planned, sent, skipped, errors, items[] }.
 *   - dryRun : ne rien envoyer ni journaliser, juste le plan.
 *   - limit  : plafond d'envois pour ce passage (défaut 20).
 */
async function runLifecycle({ dryRun = false, limit = 20 } = {}) {
  const sb = getSupabase();
  const plan = await buildPlan(sb);
  const cap = Math.max(0, Math.min(500, Number(limit) || 20));
  const summary = { planned: plan.length, sent: 0, skipped: 0, errors: 0, dryRun, limit: cap, items: [] };
  const byKind = {};
  for (const p of plan) byKind[p.kind] = (byKind[p.kind] || 0) + 1;
  summary.plannedByKind = byKind;

  let budget = cap;
  for (const p of plan) {
    const item = { kind: p.kind, email: p.user.email, title: p.payload.title || null, status: 'planned' };
    if (budget <= 0) { item.status = 'deferred'; summary.skipped++; summary.items.push(item); continue; }
    if (dryRun) { summary.items.push(item); budget--; continue; }
    // Journalise AVANT l'envoi : un doublon est pire qu'un mail manqué.
    const { error: insErr } = await sb.from('lifecycle_emails_sent').insert({ user_id: p.user.userId, kind: p.kind });
    if (insErr) {
      item.status = insErr.code === '23505' ? 'already_sent' : `log_error:${insErr.message}`;
      summary.skipped++; summary.items.push(item); continue;
    }
    const { subject, html } = buildEmail(p.kind, p.payload);
    const r = await sendViaResend({ to: p.user.email, subject, html });
    if (r.ok) { item.status = 'sent'; summary.sent++; budget--; }
    else {
      item.status = `error:${r.error}`; summary.errors++;
      // Envoi raté → on retire la ligne pour réessayer au prochain passage.
      await sb.from('lifecycle_emails_sent').delete().eq('user_id', p.user.userId).eq('kind', p.kind);
    }
    summary.items.push(item);
    await new Promise((res) => setTimeout(res, 150));
  }
  return summary;
}

// Test ciblé : envoie UN email d'un kind donné à une adresse, sans toucher
// au journal (preview réelle en boîte mail).
async function sendTestEmail({ kind, to, locale = 'fr', firstName = null }) {
  const payload = { locale, firstName, title: 'Mon titre', score: 74, ficheUrl: `${APP_BASE()}/dashboard` };
  const { subject, html } = buildEmail(kind, payload);
  return sendViaResend({ to, subject, html });
}

// Désinscription : bloque les 3 emails pour cet utilisateur.
async function markOptOut(userId) {
  const sb = getSupabase();
  const rows = KINDS.map((kind) => ({ user_id: userId, kind }));
  const { error } = await sb.from('lifecycle_emails_sent').upsert(rows, { onConflict: 'user_id,kind', ignoreDuplicates: true });
  if (error) throw new Error(error.message);
  return true;
}

module.exports = { runLifecycle, buildPlan, sendTestEmail, markOptOut, buildEmail, KINDS };
