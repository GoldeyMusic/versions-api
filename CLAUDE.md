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
| `/api/billing`       | Bearer pour `/checkout` + `/cancel-subscription`, signature Stripe pour `/webhook` | Stripe |
| `/api/internal`      | `X-Notify-Secret`                 | Webhooks Supabase DB (signup, deletion, feedback) |
| `/api/newsletter`    | `X-Admin-Secret` (ou `?secret=`)  | Newsletter mensuelle |
| `/api/welcome-email` | `X-Admin-Secret` (ou `?secret=`)  | Mail de bienvenue abonné (envoi manuel + preview) |
| `/api/stats`         | `?token=` vs `STATS_TOKEN`        | Stats publiques plugin (dashboard Archipel) |

Le router `/api/billing` doit être monté **avant** `express.json()`
global parce que `/billing/webhook` a besoin du raw body pour la
signature Stripe (`express.raw()` attaché dans le router lui-même).

Le router `/api/stats` est monté **avant le CORS global** parce que
le dashboard Archipel (`archipelaudio.com`) n'est pas dans
`ALLOWED_ORIGINS` — le router gère son propre CORS.

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
- `STATS_TOKEN` (stats plugin — fail-closed si absent, query param `?token=`)
- `DELETION_TOKEN_SECRET` (HMAC tokens suppression compte)

Optionnelles :
- `RESEND_FROM`, `RESEND_USER_FROM`, `OPS_NOTIFY_EMAIL`
- `APP_BASE_URL` (default `https://versions.studio`)
- `ALLOWED_ORIGINS` (CORS whitelist, default prod + localhost:5173)
- `MONETIZATION_ENABLED` (toggle débit côté pipeline analyze)

## Livré récemment

**2026-07-21bis** :
- **Télémétrie de crash front** (`api/_client_error.js`, mount dans `server.js`).
  `POST /api/client-error` PUBLIC (le crash peut précéder l'auth), rate-limité
  par IP en mémoire (10/h, purge auto), payload 8 kb, champs tronqués côté
  serveur. Trois sorties : Railway logs (`grep [client-error]`), table Supabase
  `client_errors` (migration 047 versions-app, **APPLIQUÉE**), notif ops email
  throttlée à 1/h. Côté front : `src/lib/crashReporter.js` (window.onerror +
  unhandledrejection, cap 3 rapports/page + dédup par message, user_id/email
  lus du token localStorage sans importer le client supabase — il doit marcher
  même si c'est l'init supabase qui a crashé) + `RootErrorBoundary` dans
  `main.jsx` (écran sombre "Recharger la page" au lieu d'une page blanche) +
  `<body style="background:#0a0b14">` inline dans `index.html`. Motivation :
  page blanche non diagnosticable chez verdoljose2 (Windows/Edge 150) sans lui
  demander de manipuler sa console. CSP inchangé (`connect-src` autorisait déjà
  le domaine Railway).
- **Express : cap upload 20 → 64 Mo** (`api/_plugin.js`). Une session 192 kHz
  produit ~23 Mo de WAV 16-bit stéréo pour 30 s → `file_too_large` systématique
  (cas verdoljose2 sous Cubase). Gemini reçoit le fichier via la File API, pas
  de limite inline 20 Mo → relever le cap est sans risque. Fix complémentaire
  côté plugin : downsample 48 kHz dans `captureSnapshotWav`
  (`PluginProcessor.cpp`, LagrangeInterpolator) — à embarquer dans la prochaine
  release ; le fix backend suffit pour débloquer les utilisateurs actuels.

**2026-07-21** :
- **Stats publiques plugin** (`api/_stats.js`, mount dans `server.js`).
  `GET /api/stats/downloads?token=XXX` — renvoie total téléchargements,
  inscrits (`auth.users` via GoTrue admin API), breakdown 7j/30j, et
  daily 90 jours (`plugin_downloads`). Auth par token statique `STATS_TOKEN`
  (fail-closed 403). CORS pour `archipelaudio.com` (router monté avant
  le CORS global). `Cache-Control: max-age=300`. Consommé par le cockpit
  Archipel (`server/audiopass-mail/admin.py`, section Vue d'ensemble).
  **À configurer** : ajouter `STATS_TOKEN` sur Railway (générer un token
  aléatoire, puis reporter la même valeur dans le `.env` du serveur
  Archipel comme `VERSIONS_STATS_TOKEN`).

**2026-07-14** :
- **Mail de bienvenue abonné** (`lib/welcomeSubscriber.js` + `api/_welcome.js`).
  Envoi automatique dans `handleSubscriptionInvoice` (`api/_billing.js`)
  UNIQUEMENT sur `invoice.billing_reason === 'subscription_create'` — jamais
  sur les renouvellements. Contenu validé par David (pas de rappel résiliation,
  pas de montant) : fonctions des analyses, avantage plugin illimité (écoute
  express + chat IA), crédits cumulables, CTA `/analyse`. Même shell visuel
  que l'annonce plugin (560px, wordmark amber, light-only). `sendSubscriberWelcome`
  ne throw jamais (webhook safety). Envoi manuel de rattrapage :
  `POST /api/welcome-email/send?to=email&plan=sub_pro[&credits=N][&dry=1]`,
  preview `GET /api/welcome-email/preview?plan=sub_pro[&name=X]` — gated
  `X-Admin-Secret` ou `?secret=`. Prénom résolu via Admin API + `profiles.prenom`
  (fallback "Salut,"). Premier envoi réel : verdoljose2@gmail.com (sub_pro
  du 2026-07-14, souscrit avant la mise en place du mail).

**2026-05-31** :
- **Endpoint `POST /api/billing/cancel-subscription`** dans `api/_billing.js`.
  Auth Bearer JWT. Lookup `stripe_subscription_id` dans `user_credits`,
  appelle `stripe.subscriptions.update(subId, { cancel_at_period_end: true })`.
  Idempotent (no-op silencieux si déjà `cancel_at_period_end` ou
  `status: 'canceled'`). Renvoie `{ ok: false, reason: 'missing_sub_id' }`
  si l'user a un `monthly_grant > 0` mais pas de `stripe_subscription_id`
  côté DB (cas des abos pré-fix-webhook 2026-05-27) — le front bascule
  alors sur le mailto contact, pas de régression. La notif ops part
  automatiquement via le handler `customer.subscription.updated`
  existant (event coché côté Stripe Dashboard 2026-05-31).

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

## Écoute express plugin (`/api/plugin/express`)

Phase 3 niveau 2 du plugin DAW. Reçoit un extrait WAV ~30-60 s en multipart
(`ExpressClient` côté plugin), lance une écoute Gemini courte
(`lib/gemini.js::analyzeListening` sur buffer inline, < 20 Mo) et renvoie un
verdict texte dans le chat du plugin.

Garde-fou coût (migration `versions-app/supabase/migrations/033_plugin_express_quota.sql`,
**APPLIQUÉE sur Supabase le 2026-06-05**) :
- Table `plugin_express_usage` (user_id + mois 'YYYY-MM' + compteur).
- RPC `plugin_express_consume()` (SECURITY DEFINER, lit `auth.uid()`,
  check + incrément atomique avec `for update`, 15 écoutes/mois) appelée
  AVANT l'écoute — 429 `express_quota` si dépassé.
- RPC `plugin_express_refund()` appelée dans le catch si l'écoute Gemini
  échoue (politique "jamais débiter sur échec", cf. crédits 4 paliers).
- Appel via le JWT user (`Authorization: Bearer`) → quota effectif
  seulement quand le plugin envoie un token (Phase 2.B auth). Sans token =
  mode dégradé (helper `callExpressQuotaRpc` renvoie null, pas de blocage).

### Profil utilisateur + mode stem (DÉPLOYÉ, commits 1b55c40 / 4cc8afb)

`/api/plugin/express` lit 4 champs de form optionnels (`userLevel`,
`userMonitors`, `userHeadphones`, `userGenres`) + `channelType`, et les injecte
dans le prompt Gemini via `opts.extraContext` (apposé au prompt dans
`lib/gemini.js::analyzeListening`) :
- **Profil** : bloc « contexte d'écoute SEULEMENT, n'en parle que si un point y
  gagne » (niveau → vocabulaire ; monitors/casques → contextualiser sans
  inventer de specs).
- **Mode stem** : si `channelType` n'est pas un bus de somme (`/master|mix
  bus|music bus/i`), bascule en « PISTE ISOLÉE » → évalue comme un stem
  (timbre/dynamique/transitoires), NE commente PAS l'absence des autres
  instruments ni l'équilibre du mix, étiquetage prudent des instruments
  (« le bas du spectre de ce bus », pas « la basse »).
- Sur `main` = en phase avec `origin/main` → **auto-déployé sur Railway**.
  Validé par David (drum bus / instrument bus). Réf : `versions-plugin/docs/
  EXPRESS_PROFILE_BACKEND.md`.

## Points en suspens

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
- **Enrichir le pool de conseils newsletter** (`lib/newsletter.js`) —
  actuellement `CONSEILS_DU_MOIS` = 12 entrées (un par mois, rotatif
  annuel) et `IDEES_PROCHAINE_SESSION` = 4 entrées (template inactif).
  Les users qui restent abonnés reçoivent toujours le même conseil au
  même mois d'une année sur l'autre. Passer à **36+ tips** côté actif
  (mix, monitoring, workflow DAW, mastering prep) et étoffer les idées
  du template inactif. Stratégie de rotation à revoir : hash
  `(userId, month)` pour ne pas envoyer 2 fois le même conseil à un
  même user. **À terme** : conseils dynamiques basés sur les vraies
  analyses du mois (recurring weaknesses dans les fiches → conseil
  ciblé). Tracké aussi dans `~/versions-app/docs/ROADMAP.md` Bloc 4.
