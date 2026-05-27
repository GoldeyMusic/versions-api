/**
 * lib/newsletter.js — newsletter mensuelle utilisateurs (récap perso).
 *
 * Calcule pour chaque user les stats d'un mois donné et envoie un email
 * branded Versions via Resend. Deux templates :
 *   - actif    : ≥ 1 analyse dans le mois → stats + meilleur score +
 *                conseil + CTA dashboard.
 *   - inactif  : 0 analyse → message doux + idées pour la prochaine
 *                session + CTA "analyser un titre".
 *
 * Conventions :
 *   - Le mois résumé est par défaut le MOIS PRÉCÉDENT (la newsletter est
 *     pensée pour être déclenchée par un cron le 1er du mois → on récapitule
 *     le mois qui vient de se terminer). On peut surcharger via { month:
 *     'YYYY-MM' } dans tous les exports — utile pour preview/test.
 *   - Admins exclus : berdugo.david@gmail.com, davidabakan@gmail.com.
 *   - On NE jette JAMAIS : toute erreur user-level est capturée et loggée,
 *     pour ne pas faire planter l'envoi des autres.
 *
 * Cron : voir api/_newsletter.js pour les recommandations de scheduling
 * externe (Railway cron / cron-job.org).
 */

const { createClient } = require('@supabase/supabase-js');
const { getBalance } = require('./credits');

const ADMIN_EMAILS = new Set([
  'berdugo.david@gmail.com',
  'davidabakan@gmail.com',
]);

const RESEND_FROM = process.env.RESEND_USER_FROM || 'Versions <contact@versions.studio>';
const APP_BASE = () => process.env.APP_BASE_URL || 'https://versions.studio';

const MONTH_NAMES_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
];

// Pool de 12 conseils, un par mois (index = mois 0-11). Rotatifs : le
// même conseil revient chaque année au même mois. Court, actionnable,
// ton coach studio (FR).
const CONSEILS_DU_MOIS = [
  // janvier
  'Tente une A/B avec un mix de référence pro avant de bouncer. Compare en mono — si ton mix tient en mono, il tiendra partout.',
  // février
  'Mute la voix lead pendant 30 secondes et écoute l\'instru seule. Si elle s\'aplatit, c\'est que la voix porte trop de poids harmonique.',
  // mars
  'Coupe tout en-dessous de 30 Hz avec un HPF doux sur le master. Ça libère 1-2 dB de headroom sans changer la perception.',
  // avril
  'Bounce ton mix, sors marcher 20 minutes, réécoute au casque ET sur ton téléphone. La fatigue auditive masque les vrais déséquilibres.',
  // mai
  'Sur ta prochaine session, commence par le kick et la voix lead, dans cet ordre. Tout le reste se construit autour.',
  // juin
  'Si une track sonne "boue", regarde la zone 200-400 Hz : c\'est presque toujours là que ça s\'accumule. Une coupe de -3 dB suffit souvent.',
  // juillet
  'Pour le mastering, vise -14 LUFS intégrés pour le streaming. Plus fort ≠ mieux — Spotify normalise tout de toute façon.',
  // août
  'Une bonne reverb ne s\'entend pas, elle se ressent. Si tu l\'entends comme un effet, baisse le dry/wet de moitié.',
  // septembre
  'Compresse en parallèle plutôt qu\'en série sur la voix lead : tu gardes la dynamique tout en ajoutant du corps.',
  // octobre
  'Avant de pousser le master, vérifie que ton mix bus est déjà à -6 dB peak. Si tu satures avant le mastering, tu masqueras tes vraies forces.',
  // novembre
  'Les transitions entre couplet et refrain sont 80% du ressenti d\'énergie. Travaille le -1 mesure du refrain plus que le refrain lui-même.',
  // décembre
  'Fais une pause de 24h entre la fin du mix et le mastering. Les oreilles fraîches valent dix plugins.',
];

// Pool de 4 idées pour la prochaine session (template inactif). Affichées
// en bloc, choix d'un random index basé sur le mois pour stabilité.
const IDEES_PROCHAINE_SESSION = [
  'Reprends une track abandonnée et change-en juste le BPM de ±5 BPM. Souvent ça débloque toute la prod.',
  'Importe un mix de référence dans ton DAW et essaie d\'égaler son équilibre sub/bass/mid à l\'oreille, sans regarder.',
  'Enregistre une voix improvisée sans paroles sur 2 minutes. Tu seras surpris par les mélodies qui sortent.',
  'Lance une nouvelle prod en partant uniquement d\'un sample d\'1 seconde de vinyle. Contrainte = créativité.',
];

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing — newsletter unavailable');
  }
  _supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _supabase;
}

// ─── Date helpers ─────────────────────────────────────────────────

/**
 * Résout le mois à résumer.
 *
 * - `monthHint` au format 'YYYY-MM' : utilisé tel quel.
 * - Sinon : MOIS PRÉCÉDENT (la newsletter est tirée le 1er du mois, on
 *   récapitule le mois qui vient de se terminer).
 *
 * Options :
 *   - `wide` : si true, recule le début de fenêtre d'un mois supplémentaire
 *     (fenêtre totale = 2 mois). Utile pour le PREMIER envoi : on veut que
 *     les users récents voient leurs analyses même si elles datent du mois
 *     d'avant. Le label/year exposés restent ceux du mois cible (le titre
 *     du mail reste "Ton mois de mai" même si les stats couvrent
 *     avril+mai).
 *
 * Renvoie { year, monthIndex (0-11), monthLabelFr, startIso, endIso }.
 * startIso/endIso sont en UTC (ISO 8601) et permettent le filtre
 * created_at >= start AND created_at < end.
 */
function resolveMonth(monthHint, { wide = false } = {}) {
  let year, monthIndex;
  if (typeof monthHint === 'string' && /^\d{4}-\d{2}$/.test(monthHint)) {
    const [y, m] = monthHint.split('-').map(Number);
    year = y;
    monthIndex = Math.max(0, Math.min(11, m - 1));
  } else {
    const now = new Date();
    // Mois précédent
    year = now.getUTCFullYear();
    monthIndex = now.getUTCMonth() - 1;
    if (monthIndex < 0) {
      monthIndex = 11;
      year -= 1;
    }
  }
  // Début de fenêtre : par défaut = 1er du mois cible. Si wide, recule
  // d'un mois supplémentaire (-1 month) — Date.UTC gère les passages
  // d'année (mois -1 d'année Y devient mois 11 d'année Y-1).
  const startMonthIndex = wide ? monthIndex - 1 : monthIndex;
  const start = new Date(Date.UTC(year, startMonthIndex, 1, 0, 0, 0));
  const end = new Date(Date.UTC(monthIndex === 11 ? year + 1 : year, (monthIndex + 1) % 12, 1, 0, 0, 0));
  return {
    year,
    monthIndex,
    monthLabelFr: MONTH_NAMES_FR[monthIndex],
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    wide,
  };
}

// ─── Stats helpers ────────────────────────────────────────────────

/**
 * Calcule les stats du mois pour un user. Renvoie un objet sérialisable
 * (jamais null), même si une sous-requête échoue (les compteurs tombent
 * à 0 et on logge le warning).
 */
async function computeMonthlyStats({ userId, month, wide = false }) {
  const sb = getSupabase();
  const { startIso, endIso, monthLabelFr, year } = resolveMonth(month, { wide });

  // 1) Analyses du mois — count credit_events.reason='debit_analysis'.
  //    debit_analysis est signé négatif côté ledger, mais on ne filtre pas
  //    sur le signe (un éventuel refund est sa propre row 'refund_failed').
  let analysesCount = 0;
  try {
    const { count, error } = await sb
      .from('credit_events')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('reason', 'debit_analysis')
      .gte('created_at', startIso)
      .lt('created_at', endIso);
    if (error) throw error;
    analysesCount = count || 0;
  } catch (err) {
    console.warn(`[newsletter] analysesCount failed for ${userId}:`, err.message);
  }

  // 2) Tracks du user → versions du mois (jointure côté backend).
  //    On récupère analysis_result pour pouvoir extraire globalScore et
  //    le titre, et regrouper par track_id pour la progression.
  let versions = [];
  try {
    const { data: trackRows, error: tErr } = await sb
      .from('tracks')
      .select('id, title')
      .eq('user_id', userId);
    if (tErr) throw tErr;
    const tracks = trackRows || [];
    const trackIds = tracks.map(t => t.id);
    if (trackIds.length > 0) {
      const { data: vRows, error: vErr } = await sb
        .from('versions')
        .select('id, track_id, name, created_at, analysis_result')
        .in('track_id', trackIds)
        .gte('created_at', startIso)
        .lt('created_at', endIso);
      if (vErr) throw vErr;
      const titleById = new Map(tracks.map(t => [t.id, t.title]));
      versions = (vRows || []).map(v => ({
        id: v.id,
        trackId: v.track_id,
        trackTitle: titleById.get(v.track_id) || '—',
        name: v.name,
        createdAt: v.created_at,
        globalScore: v?.analysis_result?.fiche?.globalScore ?? null,
        verdict: v?.analysis_result?.fiche?.verdict
              || v?.analysis_result?.fiche?.summary
              || null,
      }));
    }
  } catch (err) {
    console.warn(`[newsletter] versions fetch failed for ${userId}:`, err.message);
  }

  const versionsCount = versions.length;

  // Meilleur score du mois + titre associé
  let bestScore = null;
  let bestTrackTitle = null;
  let bestVerdict = null;
  for (const v of versions) {
    if (typeof v.globalScore === 'number' && (bestScore === null || v.globalScore > bestScore)) {
      bestScore = v.globalScore;
      bestTrackTitle = v.trackTitle;
      bestVerdict = v.verdict;
    }
  }

  // Progression moyenne (positive uniquement) : pour chaque track avec
  // ≥ 2 versions ce mois-ci, on calcule les deltas entre versions
  // consécutives (V(n) - V(n-1)) et on garde les deltas > 0. Moyenne.
  let progressionAvg = null;
  try {
    const byTrack = new Map();
    for (const v of versions) {
      if (!byTrack.has(v.trackId)) byTrack.set(v.trackId, []);
      byTrack.get(v.trackId).push(v);
    }
    const positives = [];
    for (const arr of byTrack.values()) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
      for (let i = 1; i < arr.length; i++) {
        const prev = arr[i - 1].globalScore;
        const cur = arr[i].globalScore;
        if (typeof prev === 'number' && typeof cur === 'number') {
          const delta = cur - prev;
          if (delta > 0) positives.push(delta);
        }
      }
    }
    if (positives.length > 0) {
      const sum = positives.reduce((a, b) => a + b, 0);
      progressionAvg = Math.round((sum / positives.length) * 10) / 10;
    }
  } catch (err) {
    console.warn(`[newsletter] progression compute failed for ${userId}:`, err.message);
  }

  // 3) Recommandations appliquées (mix_note_completions completed=true)
  let recosCount = 0;
  try {
    const { count, error } = await sb
      .from('mix_note_completions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('completed', true)
      .gte('completed_at', startIso)
      .lt('completed_at', endIso);
    if (error) throw error;
    recosCount = count || 0;
  } catch (err) {
    console.warn(`[newsletter] recosCount failed for ${userId}:`, err.message);
  }

  // 4) Crédits restants
  let creditsRemaining = 0;
  try {
    const bal = await getBalance(userId);
    creditsRemaining = bal?.balance ?? 0;
  } catch (err) {
    console.warn(`[newsletter] balance failed for ${userId}:`, err.message);
  }

  return {
    monthLabelFr,
    year,
    analysesCount,
    versionsCount,
    bestScore,
    bestTrackTitle,
    bestVerdict,
    progressionAvg,
    recosCount,
    creditsRemaining,
    isActive: analysesCount > 0,
  };
}

// ─── HTML helpers ─────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Bandeau header + footer commun aux deux templates. Palette light-only :
// fond blanc partout (header inclus), logo amber, cartes crème, séparateurs
// crème foncé. Pas de dark mode — UX David 2026-05-27.
function shellHtml({ title, bodyHtml, ctaLabel, ctaHref, creditsRemaining, monthLabel, year }) {
  const unsubscribe = 'mailto:contact@versions.studio?subject=Désabonnement%20newsletter';
  const ctaHtml = ctaHref ? `
        <tr>
          <td align="center" style="padding:8px 40px 32px">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" style="background:#f5b056;border-radius:10px">
                  <a href="${escapeHtml(ctaHref)}" target="_blank" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:600;color:#1a1a1a;text-decoration:none;letter-spacing:0.01em">${escapeHtml(ctaLabel || 'Ouvrir le dashboard')}</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>` : '';

  const creditsLine = (typeof creditsRemaining === 'number')
    ? `<p style="margin:0 0 8px;font-size:13px;color:#666">Il te reste <strong style="color:#1a1a1a">${creditsRemaining} crédit${creditsRemaining > 1 ? 's' : ''}</strong> sur ton compte.</p>`
    : '';

  const headerSubtitle = monthLabel
    ? `Récap · ${escapeHtml(monthLabel)}${year ? ' ' + year : ''}`
    : 'Analyse · Compare · Évolue';

  return `<!doctype html>
<html lang="fr">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1a1a1a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;padding:40px 16px">
  <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e0d8cc">
        <tr>
          <td align="center" style="padding:36px 32px 20px;background:#ffffff;border-bottom:1px solid #e0d8cc">
            <div style="font-size:32px;font-weight:800;letter-spacing:0.04em;color:#f5b056;margin-bottom:6px">VERSiONS</div>
            <div style="font-size:12px;font-weight:500;letter-spacing:0.08em;color:#999;text-transform:uppercase">${headerSubtitle}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 40px 8px;background:#ffffff">
            ${bodyHtml}
          </td>
        </tr>
        ${ctaHtml}
        <tr>
          <td style="padding:24px 40px 32px;border-top:1px solid #e0d8cc;background:#faf7f2">
            ${creditsLine}
            <p style="margin:0;font-size:12px;color:#666;line-height:1.5">Tu reçois ce mail parce que tu as un compte Versions. <a href="${unsubscribe}" style="color:#666;text-decoration:underline">Me désabonner de la newsletter</a>.</p>
            <p style="margin:12px 0 0;font-size:11px;color:#999">Versions — analyse mix &amp; mastering pour artistes · <a href="https://versions.studio" style="color:#999;text-decoration:underline">versions.studio</a></p>
          </td>
        </tr>
      </table>
  </td></tr>
</table>
</body></html>`;
}

// Extrait un prénom propre depuis prenom DB / display_name / email.
function firstNameFrom({ prenom, displayName, email }) {
  const candidate = (prenom || '').trim()
    || (displayName || '').trim().split(/\s+/)[0]
    || (email || '').split('@')[0];
  if (!candidate) return '';
  // Capitalise première lettre (UX : "salut david" → "Salut David").
  return candidate.charAt(0).toUpperCase() + candidate.slice(1);
}

// ─── Templates ────────────────────────────────────────────────────

function renderActiveHtml({ firstName, stats }) {
  const greeting = firstName ? `Salut ${escapeHtml(firstName)},` : 'Salut,';
  const monthLabel = stats.monthLabelFr;

  const statsRows = [];
  statsRows.push(`<tr><td style="padding:10px 0;font-size:14px;color:#666">Analyses lancées</td><td align="right" style="padding:10px 0;font-size:15px;font-weight:600;color:#1a1a1a">${stats.analysesCount}</td></tr>`);
  statsRows.push(`<tr><td style="padding:10px 0;font-size:14px;color:#666;border-top:1px solid #e0d8cc">Versions uploadées</td><td align="right" style="padding:10px 0;font-size:15px;font-weight:600;color:#1a1a1a;border-top:1px solid #e0d8cc">${stats.versionsCount}</td></tr>`);
  if (stats.progressionAvg !== null && stats.progressionAvg > 0) {
    statsRows.push(`<tr><td style="padding:10px 0;font-size:14px;color:#666;border-top:1px solid #e0d8cc">Progression moyenne</td><td align="right" style="padding:10px 0;font-size:15px;font-weight:600;color:#1a9f4a;border-top:1px solid #e0d8cc">+${stats.progressionAvg} pts</td></tr>`);
  }
  statsRows.push(`<tr><td style="padding:10px 0;font-size:14px;color:#666;border-top:1px solid #e0d8cc">Recommandations appliquées</td><td align="right" style="padding:10px 0;font-size:15px;font-weight:600;color:#1a1a1a;border-top:1px solid #e0d8cc">${stats.recosCount}</td></tr>`);

  const bestBlock = (typeof stats.bestScore === 'number')
    ? `
      <div style="margin:24px 0 8px;padding:18px 20px;background:#faf7f2;border:1px solid #e8e2d8;border-radius:12px">
        <div style="font-size:11px;font-weight:600;letter-spacing:0.12em;color:#999;text-transform:uppercase;margin-bottom:8px">Meilleur score du mois</div>
        <div style="font-size:30px;font-weight:800;color:#f5b056;line-height:1.1">${stats.bestScore}<span style="font-size:16px;color:#999;font-weight:600">/100</span></div>
        <div style="margin-top:6px;font-size:14px;color:#666"><strong style="color:#1a1a1a">${escapeHtml(stats.bestTrackTitle || '—')}</strong>${stats.bestVerdict ? ` — ${escapeHtml(String(stats.bestVerdict).slice(0, 140))}` : ''}</div>
      </div>`
    : '';

  const conseil = CONSEILS_DU_MOIS[(stats.monthIndex ?? (MONTH_NAMES_FR.indexOf(stats.monthLabelFr))) % 12]
                || CONSEILS_DU_MOIS[0];

  const bodyHtml = `
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#1a1a1a;letter-spacing:-0.01em">${greeting}</h1>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#666">Voici ton récap de <strong style="color:#1a1a1a">${escapeHtml(monthLabel)}</strong>. Du concret, pas de blabla.</p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid #e0d8cc;border-bottom:1px solid #e0d8cc">
      ${statsRows.join('\n      ')}
    </table>

    ${bestBlock}

    <div style="margin:24px 0 8px;padding:18px 20px;background:#faf7f2;border:1px solid #e8e2d8;border-left:4px solid #f5b056;border-radius:12px">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.12em;color:#d4900e;text-transform:uppercase;margin-bottom:8px">Conseil du mois</div>
      <div style="font-size:14px;color:#1a1a1a;line-height:1.55">${escapeHtml(conseil)}</div>
    </div>

    <p style="margin:24px 0 8px;font-size:15px;line-height:1.6;color:#666">Continue comme ça. Le mois prochain, on remet ça.</p>
  `;

  return shellHtml({
    title: `Ton mois de ${monthLabel} sur Versions`,
    bodyHtml,
    ctaLabel: 'Ouvrir le dashboard',
    ctaHref: APP_BASE(),
    creditsRemaining: stats.creditsRemaining,
    monthLabel,
    year: stats.year,
  });
}

function renderInactiveHtml({ firstName, stats }) {
  const greeting = firstName ? `Salut ${escapeHtml(firstName)},` : 'Salut,';
  const monthLabel = stats.monthLabelFr;
  const conseil = CONSEILS_DU_MOIS[(stats.monthIndex ?? (MONTH_NAMES_FR.indexOf(stats.monthLabelFr))) % 12]
                || CONSEILS_DU_MOIS[0];
  // Choix d'une idée stable pour le mois courant (rotatif sur 4)
  const ideaIndex = (MONTH_NAMES_FR.indexOf(stats.monthLabelFr) + 1) % IDEES_PROCHAINE_SESSION.length;
  const idea = IDEES_PROCHAINE_SESSION[ideaIndex];

  const bodyHtml = `
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#1a1a1a;letter-spacing:-0.01em">${greeting}</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#666">Pas d'analyse ce mois-ci, et c'est pas grave. Les périodes off font partie du process — on revient toujours plus affûté.</p>

    <div style="margin:16px 0 8px;padding:18px 20px;background:#faf7f2;border:1px solid #e8e2d8;border-left:4px solid #f5b056;border-radius:12px">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.12em;color:#d4900e;text-transform:uppercase;margin-bottom:8px">Conseil du mois</div>
      <div style="font-size:14px;color:#1a1a1a;line-height:1.55">${escapeHtml(conseil)}</div>
    </div>

    <div style="margin:16px 0 8px;padding:18px 20px;background:#faf7f2;border:1px solid #e8e2d8;border-radius:12px">
      <div style="font-size:11px;font-weight:600;letter-spacing:0.12em;color:#999;text-transform:uppercase;margin-bottom:8px">Idée pour ta prochaine session</div>
      <div style="font-size:14px;color:#1a1a1a;line-height:1.55">${escapeHtml(idea)}</div>
    </div>

    <p style="margin:24px 0 8px;font-size:15px;line-height:1.6;color:#666">Quand t'es prêt, balance un mix dans Versions — on regarde ça ensemble.</p>
  `;

  return shellHtml({
    title: `Ton mois de ${monthLabel} sur Versions`,
    bodyHtml,
    ctaLabel: 'Analyser un titre',
    ctaHref: APP_BASE(),
    creditsRemaining: stats.creditsRemaining,
    monthLabel,
    year: stats.year,
  });
}

/**
 * Renvoie { subject, html } pour un user donné. Utilisé par
 * /preview ET par /send pour garder le rendu cohérent.
 */
async function buildNewsletter({ userId, email, prenom, displayName, month, wide = false }) {
  const stats = await computeMonthlyStats({ userId, month, wide });
  // monthIndex utile pour le conseil rotatif
  stats.monthIndex = MONTH_NAMES_FR.indexOf(stats.monthLabelFr);
  const firstName = firstNameFrom({ prenom, displayName, email });
  const html = stats.isActive
    ? renderActiveHtml({ firstName, stats })
    : renderInactiveHtml({ firstName, stats });
  const subject = `Ton mois de ${stats.monthLabelFr} sur Versions`;
  return { subject, html, stats };
}

// ─── Resend send ──────────────────────────────────────────────────

async function sendEmailViaResend({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[newsletter] RESEND_API_KEY missing → email skipped:', to);
    return { ok: false, error: 'resend_api_key_missing' };
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [to],
        subject,
        html,
        // List-Unsubscribe (RFC 2369/8058) : Gmail et Outlook affichent un
        // bouton "Se désabonner" natif en haut du mail. Tant qu'on n'a pas
        // d'endpoint /unsubscribe automatique, on pointe sur le mailto —
        // ça déclenche la modale standard du client mail, qui est traitée
        // comme un opt-out légitime par les MUA (anti-spam compliance).
        headers: {
          'List-Unsubscribe': '<mailto:contact@versions.studio?subject=Désabonnement newsletter>',
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[newsletter] resend failed:', res.status, body);
      return { ok: false, error: `resend_${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    console.error('[newsletter] sendEmailViaResend threw:', e.message);
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── User listing ─────────────────────────────────────────────────

/**
 * Liste tous les users Supabase auth (paginés), résout leur prenom via
 * public.profiles, exclut les admins. Renvoie [{ userId, email, prenom,
 * displayName }].
 */
async function listRecipients() {
  const sb = getSupabase();
  const recipients = [];
  let page = 1;
  const perPage = 200;
  // Loop pagination — Supabase Admin API renvoie au max 1000 par page.
  // En pratique on a < 1k users, mais on boucle proprement quand même.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const users = data?.users || [];
    for (const u of users) {
      if (!u?.id || !u?.email) continue;
      if (ADMIN_EMAILS.has(u.email.toLowerCase())) continue;
      // email non confirmé → on n'envoie pas (probably spammy ou jamais activé)
      if (!u.email_confirmed_at) continue;
      recipients.push({
        userId: u.id,
        email: u.email,
        displayName: u.user_metadata?.full_name || u.user_metadata?.name || null,
      });
    }
    if (users.length < perPage) break;
    page += 1;
    if (page > 50) break; // safety
  }

  // Résolution batch des prenoms via profiles (un seul aller-retour).
  if (recipients.length > 0) {
    try {
      const ids = recipients.map(r => r.userId);
      const { data: profiles, error } = await sb
        .from('profiles')
        .select('id, prenom')
        .in('id', ids);
      if (!error && profiles) {
        const byId = new Map(profiles.map(p => [p.id, p.prenom]));
        for (const r of recipients) {
          r.prenom = byId.get(r.userId) || null;
        }
      }
    } catch (err) {
      console.warn('[newsletter] profiles lookup failed:', err.message);
    }
  }

  return recipients;
}

// ─── Orchestrator ─────────────────────────────────────────────────

/**
 * Envoie la newsletter à tous les recipients éligibles. Synchrone, traite
 * un user à la fois avec 150ms de délai entre chaque envoi (Resend free
 * plan ≈ 10 req/s → on reste très en-dessous). Renvoie un résumé.
 *
 * Options :
 *   - onlyEmails : array d'emails ; si fourni, n'envoie QUE à ces users
 *     (lookup via findUserByEmail). Bypass la liste d'exclusion admin
 *     naturellement — utile pour test send vers soi-même / Abakan, ou
 *     re-send ciblé. Si un email est introuvable, log warn + skip.
 */
async function sendNewsletterToAll({ month, wide = false, dryRun = false, onlyEmails = null } = {}) {
  let recipients;
  if (Array.isArray(onlyEmails) && onlyEmails.length > 0) {
    recipients = [];
    for (const email of onlyEmails) {
      const u = await findUserByEmail(email);
      if (u) {
        recipients.push(u);
      } else {
        console.warn(`[newsletter] only-mode: user not found for ${email} — skipped`);
      }
    }
  } else {
    recipients = await listRecipients();
  }
  const summary = {
    monthHint: month || null,
    wide,
    only: onlyEmails || null,
    total: recipients.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    dryRun,
  };

  for (const r of recipients) {
    try {
      const { subject, html, stats } = await buildNewsletter({
        userId: r.userId,
        email: r.email,
        prenom: r.prenom,
        displayName: r.displayName,
        month,
        wide,
      });
      if (dryRun) {
        summary.sent += 1;
        continue;
      }
      const result = await sendEmailViaResend({ to: r.email, subject, html });
      if (result.ok) {
        summary.sent += 1;
        console.log(`[newsletter] sent → ${r.email} (active=${stats.isActive})`);
      } else {
        summary.failed += 1;
        summary.errors.push({ email: r.email, error: result.error });
      }
    } catch (err) {
      summary.failed += 1;
      summary.errors.push({ email: r.email, error: err.message });
      console.error(`[newsletter] user ${r.email} failed:`, err.message);
    }
    // Throttle léger pour ne pas saturer Resend
    await new Promise(r => setTimeout(r, 150));
  }

  console.log(`[newsletter] done — sent=${summary.sent} failed=${summary.failed} total=${summary.total}`);
  return summary;
}

/**
 * Trouve un user par email (Admin API). Renvoie { userId, email, prenom,
 * displayName } ou null si introuvable.
 */
async function findUserByEmail(email) {
  const sb = getSupabase();
  // Admin API permet getUserByEmail directement (Supabase JS v2.43+).
  // Fallback : on liste et on filtre (1 page suffit en pratique).
  try {
    const { data, error } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw error;
    const u = (data?.users || []).find(x => (x.email || '').toLowerCase() === email.toLowerCase());
    if (!u) return null;
    let prenom = null;
    try {
      const { data: prof } = await sb.from('profiles').select('prenom').eq('id', u.id).maybeSingle();
      prenom = prof?.prenom || null;
    } catch {}
    return {
      userId: u.id,
      email: u.email,
      prenom,
      displayName: u.user_metadata?.full_name || u.user_metadata?.name || null,
    };
  } catch (err) {
    console.error('[newsletter] findUserByEmail failed:', err.message);
    return null;
  }
}

module.exports = {
  resolveMonth,
  computeMonthlyStats,
  buildNewsletter,
  sendNewsletterToAll,
  findUserByEmail,
  ADMIN_EMAILS,
};
