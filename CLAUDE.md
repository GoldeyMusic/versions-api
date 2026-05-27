# Versions API — Notes de contexte (backend)

Snapshot pour reprendre proprement le backend depuis Cowork. Le frontend
a son propre `CLAUDE.md` dans `~/versions-app/`.

## Architecture

- **Stack** : Node 20 + Express, déployé sur Railway. Mounted comme
  serverless function sur Vercel (cf. `vercel.json` + `api/index.js`)
  pour les anciens redirects ; la prod tourne sur Railway.
- **Repo** : `~/versions-api/` — anciennement `~/decode-api/` (renommé
  2026-05-05).
- **Deploy** : `git push origin main` → Railway auto-deploy.
- **DB** : Supabase Postgres + Storage. Clients :
  - `SUPABASE_ANON_KEY` pour la vérif du JWT user via `requireAuth`
    (`lib/auth.js`).
  - `SUPABASE_SERVICE_ROLE_KEY` pour tout le reste (bypass RLS).
- **Logs** : Railway dashboard. Pas d'APM.

## Routes (`api/_*.js`)

Toutes montées dans `server.js` (préfixées `/api/<name>`). L'auth varie
selon la route :

| Préfixe              | Auth                              | Rôle |
|---|---|---|
| `/api/analyze`       | `requireAuth` (Bearer JWT)        | Pipeline d'analyse Gemini/Fadr/Claude |
| `/api/chat`          | `requireAuth` + chatLimiter       | Chat fiche |
| `/api/ask`           | `requireAuth` + askLimiter        | Q/A spot sur fiche |
| `/api/listen`        | `requireAuth` + listenLimiter     | Génération `listening` Gemini |
| `/api/compare`       | `requireAuth` + compareLimiter    | Compare 2 versions |
| `/api/translate`     | `requireAuth` + translateLimiter  | i18n FR↔EN cache versions |
| `/api/mastering-charter` | `requireAuth` + masteringCharterLimiter | Génération charter |
| `/api/audio`         | `requireAuth` + audioLimiter      | Signed URL audio |
| `/api/storage`       | `requireAuth` + storageLimiter    | Upload direct Storage |
| `/api/account`       | mixte (Bearer ou token signé)     | Request/confirm deletion |
| `/api/billing`       | Bearer pour `/checkout`, signature Stripe pour `/webhook` | Stripe |
| `/api/internal`      | `X-Notify-Secret`                 | Webhooks Supabase DB (signup, deletion, feedback) |
| `/api/newsletter`    | `X-Admin-Secret` (ou `?secret=`)  | Newsletter mensuelle |

Le router `/api/billing` doit être monté **avant** `express.json()`
global parce que `/billing/webhook` a besoin du raw body pour la
signature Stripe (`express.raw()` attaché dans le router lui-même).

Le rate-limit (`lib/rateLimit.js`) est appliqué **après** `requireAuth`
pour cibler par `user.id` (et non par IP). Fallback IP-based via
`ipKeyGenerator` (express-rate-limit v8, IPv6-safe).

## Pipeline d'analyse (`api/_analyze.js`)

POST `/api/analyze/start` reçoit le multipart audio, débite 1 crédit
via `debitOrdered` (`lib/credits.js`), pose un job en mémoire, et
lance le pipeline async :

1. Upload Supabase Storage (path `tmp/<userId>/...`)
2. **Mesures DSP** (`lib/dsp.js` — ffmpeg ebur128/loudnorm/silence) →
   `measures_done`. LUFS sanitizé à [-40, +1] (mode dégradé sinon).
3. **Fadr** (`lib/fadr.js`) → BPM, key, stems metrics → `fadr_done`.
4. **Listening Gemini** (`lib/gemini.js`) → `listening_done`. Cache
   par `audio_hash` (`gemini_listening_cache`).
5. **Diagnostic Claude Sonnet 4.6** (`lib/claude.js`) → fiche complète
   → `measures_done` → `complete`.
6. **Persist backend** (`lib/persistAnalysis.js`) — insère
   `tracks`/`versions` en service_role. Le job state expose
   `persistedTrackId` / `persistedVersionId` pour que le front route
   direct sans repasser par `saveAnalysis` côté client.

Si quelque chose plante, `refundCreditIfDebited` rembourse le débit.
Polling `/status/:jobId` côté front (intervalle 3s + Page Visibility).

`analyzeLimiter` n'est PAS appliqué globalement sur `/api/analyze`
(le polling le ferait 429). Il est posé dans `_analyze.js` sur
`/start` et `/diagnose` uniquement (les routes coûteuses).

## Protection crédits — 4 paliers

Architecturé fin mai 2026 après 4 cas observés de crédit débité sans
fiche persistée. Détaillé dans `~/versions-app/CLAUDE.md` (section
"Protection des crédits — 4 paliers"). Le palier 4 (persist backend)
est ce qui ferme structurellement le bug ; les paliers 1-3 sont des
filets côté front et un cron Supabase de refund (`refund_orphan_debits`,
toutes les 30 min, fenêtre 7 jours).

## Webhook Stripe (`api/_billing.js`)

Events écoutés (l'event est dispatché dans `handleStripeEvent`) :

| Event Stripe                            | Action backend |
|---|---|
| `checkout.session.completed` (mode=payment) | Pack one-shot → crédite bucket `pack` (à vie) |
| `invoice.paid` (avec subscription)      | Abo → crédite bucket `sub` (cumulé), maj `monthly_grant`/`renews_at` |
| `customer.subscription.updated` (cancel_at_period_end false → true) | Notif ops "Intention d'annulation" — pas de mouvement DB |
| `customer.subscription.deleted`         | Purge `subscription_balance`, reset méta abo, notif ops "Abo résilié" |
| `charge.refunded`                       | Notif ops uniquement (pas de touche aux crédits) |

Idempotence : `credit_events.stripe_event_id` UNIQUE + check préalable
dans `applyCreditDelta` / `purgeSubscriptionBalance`.

**Format API Stripe** : depuis 2025-04-30.basil, `invoice.subscription`
est déplacé vers `invoice.parent.subscription_details.subscription`, et
`invoice.charge` → `invoice.payments[]`. Helpers `getInvoiceSubscriptionId`
et `fetchStripeNetForInvoice` (commit 8eb9f64) lisent les deux formats.
Pin pas posé volontairement — on suit l'API la plus récente.

**Crédits — modèle Splice** (2026-04-29) : 2 buckets dans `user_credits`
(`subscription_balance` purgeable à résiliation, `pack_balance` à vie),
mirror dans `balance_remaining`. Débit ordonné via RPC
`debit_credits_ordered` (sub d'abord, puis pack). Cumul abo (pas de
reset mensuel) — purge uniquement sur `subscription.deleted`.

## Newsletter mensuelle (`lib/newsletter.js` + `api/_newsletter.js`)

Tirée par un cron externe le 1er de chaque mois. Calcule par user :
analyses (`credit_events.reason='debit_analysis'`), versions uploadées
(jointure `tracks → versions`), meilleur score (`analysis_result.fiche.globalScore`),
progression (moyenne deltas positifs entre versions consécutives d'une
même track), recos appliquées (`mix_note_completions`), crédits restants.

Deux templates HTML inline (`shellHtml` + `renderActiveHtml` /
`renderInactiveHtml`). Palette charte amber (`#f5b056` accents,
`#d4900e` petits textes), light-only. Conseil rotatif du mois
(pool de 12). Envoi via Resend avec header `List-Unsubscribe`
(bouton natif Gmail/Outlook).

**Endpoints** (gated `X-Admin-Secret` ou `?secret=`) :
- `POST /api/newsletter/send` — params `?month=YYYY-MM&wide=1&only=a,b&dry=1`
- `GET /api/newsletter/preview?email=...` — rendu HTML sans envoi

**Mois résumé par défaut** = mois précédent (cron sur le 1er → récap du
mois écoulé). `?wide=1` étend la fenêtre à 2 mois (utile pour le tout
premier envoi). `?only=email1,email2` bypass la liste d'exclusion admin
— c'est comme ça que David et Abakan peuvent recevoir la newsletter
(sinon filtrés par `ADMIN_EMAILS` dans `listRecipients`).

**Cron** à configurer en externe (cron-job.org ou Railway cron) :
`0 9 1 * *` → `POST https://<api>/api/newsletter/send?secret=...`.

## Notifications ops (`lib/notifyOps.js` + `api/_internal.js`)

- **Signup** : webhook Supabase DB sur INSERT `auth.users` →
  `/api/internal/notify-signup` → mail "Nouvel inscrit".
- **Deletion** : webhook Supabase DB sur DELETE `auth.users` →
  `/api/internal/notify-deletion` → mail "Compte supprimé".
- **Feedback** : webhook Supabase DB sur INSERT `public.feedback` →
  `/api/internal/notify-feedback` → mail "Nouvel avis testeur" avec
  NPS color-coded + verbatims.
- **Billing** : envois directs depuis `api/_billing.js` (pack acheté,
  abo créé, abo résilié, intention d'annulation, refund).

Destinataire : `OPS_NOTIFY_EMAIL` (default `contact@versions.studio`).
Sender ops : `RESEND_FROM` (default `onboarding@resend.dev` tant que
versions.studio pas vérifié dans Resend).

Sender user (mails account + newsletter) : `RESEND_USER_FROM` (default
`Versions <contact@versions.studio>`). Suppose le domaine vérifié.

## Suppression de compte (`api/_account.js`)

Flow 2-step pour éviter les suppressions accidentelles + hijack de
session :
1. `POST /api/account/request-deletion` (Bearer) → envoie mail avec
   token signé HMAC 1h.
2. `POST /api/account/confirm-deletion` (body=token) → appel RPC
   `delete_user_account(p_user_id)` (service_role) qui purge en
   cascade toutes les tables liées + `auth.users`. Email "À bientôt"
   au user. Webhook Supabase DELETE auto → notif ops.

## Variables d'env (Railway)

Critiques :
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `FADR_API_KEY`
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `RESEND_API_KEY`
- `INTERNAL_NOTIFY_SECRET` (header X-Notify-Secret webhooks Supabase)
- `ADMIN_SECRET` (newsletter — fail-closed si absent)
- `DELETION_TOKEN_SECRET` (HMAC tokens suppression compte)

Optionnelles :
- `RESEND_FROM`, `RESEND_USER_FROM`, `OPS_NOTIFY_EMAIL`
- `APP_BASE_URL` (default `https://versions.studio`)
- `ALLOWED_ORIGINS` (CORS whitelist, default prod + localhost:5173)
- `MONETIZATION_ENABLED` (toggle débit côté pipeline analyze)

## Livré récemment

**2026-05-27** :
- **Newsletter mensuelle utilisateurs** (`lib/newsletter.js`,
  `api/_newsletter.js`, mount dans `server.js`). Stats par user via
  Supabase service_role, 2 templates HTML light-only (charte amber
  `#f5b056` / `#d4900e`), pool de 12 conseils rotatifs, envoi Resend
  avec header `List-Unsubscribe`. Params `?month=YYYY-MM`, `?wide=1`
  (fenêtre 2 mois pour premier envoi), `?only=email1,email2` (bypass
  liste admins), `?dry=1`, `?secret=` (auth en query pour iPhone).
  GET `/preview?email=...` pour preview HTML sans envoi.
- **Notif intention d'annulation** — handler
  `customer.subscription.updated` dans `_billing.js` qui détecte la
  transition `cancel_at_period_end: false → true` via
  `event.data.previous_attributes`. Notif ops uniquement, pas de
  mouvement DB (l'abo reste actif jusqu'à `current_period_end`, puis
  le handler `.deleted` existant prend le relais).

**2026-05-26** :
- **Fix webhook Stripe abonnements** (commit 8eb9f64) — API Stripe
  basil/clover (2025-04-30) déplace `invoice.subscription` vers
  `invoice.parent.subscription_details.subscription` et supprime
  `invoice.charge`. Helpers `getInvoiceSubscriptionId(invoice)` et
  `fetchStripeNetForInvoice()` lisent les 2 formats. Symptôme avant fix :
  le sub Indie 14,99€ de TbGKrKW0qWrCx6Y débité par Stripe sans
  contrepartie côté Versions (silencieusement rejeté).

**2026-05-21** : voir détail dans `~/versions-app/CLAUDE.md` section
"Livré 2026-05-21" (hotfix ReferenceError persistAnalysisResult,
patch IPv6 rateLimit, garde-fou LUFS aberrant, refonte
question "masterisé ?").

## Points en suspens

- **Cocher `customer.subscription.updated` dans les Listened events
  du webhook Stripe** (dashboard.stripe.com → Developers → Webhooks
  → endpoint prod). Sans ce check, le nouveau handler cancel-intent
  (commit `bedf633`) ne sera jamais appelé.
- **Configurer cron mensuel newsletter** sur cron-job.org (ou Railway
  cron) — `0 9 1 * *`, POST `https://<api>/api/newsletter/send` avec
  header `X-Admin-Secret`. Sans `?wide=1` (le premier envoi manuel l'a
  déjà utilisé, les suivants couvrent juste le mois écoulé).
- **Corriger le barème des verdicts** : 75/100 ne devrait pas
  déclencher "aïe aïe aïe". La calibration vit dans le system prompt
  de `lib/claude.js` (cherche "ECHELLE GLOBALE OBLIGATOIRE" et les
  consignes verdict). Probablement à remonter le seuil "verdict
  négatif" autour de 60-65 et ajouter une zone neutre 70-79.
- **Vérifier le domaine versions.studio dans Resend** (DNS SPF/DKIM).
  Sans ça, les mails partant avec `from: Versions <contact@versions.studio>`
  échouent — actuellement `RESEND_USER_FROM` peut fallback sur
  `onboarding@resend.dev` mais c'est moche en prod.
- **Idempotence des notifs ops** (faible priorité) — Stripe peut retry
  un event sur transient failure → mail dupliqué. Pas de table dédiée
  pour l'instant. Si ça devient bruyant, créer `notified_stripe_events`
  avec UNIQUE sur `event_id`.
