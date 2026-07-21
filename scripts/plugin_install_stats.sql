-- scripts/plugin_install_stats.sql
-- RPC consommée par api/_stats.js (GET /api/stats/downloads), affichée dans
-- le cockpit Archipel. Appliquée directement sur Supabase (projet GoldeyMusic).
--
-- « Installation » = un utilisateur ayant RÉELLEMENT ouvert le plugin
-- (table plugin_first_seen — migration 044), décliné par plateforme de
-- téléchargement (Mac / Windows ; 'unknown' si ouvert sans download loggé).
-- C'est la même notion que la page /admin de l'app Versions (décision
-- 2026-07-10) : les téléchargements bruts (plugin_downloads) ne comptent PAS
-- comme installs — ils servent uniquement à déduire la plateforme. Les emails
-- de exclude_emails (équipe interne) sont retirés. Daté à first_seen_at
-- (adoption réelle) → la somme du breakdown quotidien (90 j) == total.

CREATE OR REPLACE FUNCTION public.plugin_install_stats(exclude_emails text[] DEFAULT '{}')
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH ex AS (
    SELECT lower(trim(e)) AS e FROM unnest(coalesce(exclude_emails, '{}')) AS e
  ),
  openers AS (  -- ont réellement ouvert le plugin, hors équipe
    SELECT p.user_id, p.first_seen_at
    FROM public.plugin_first_seen p
    WHERE p.user_id IS NOT NULL
      AND lower(p.email) NOT IN (SELECT e FROM ex)
  ),
  user_platforms AS (  -- plateformes distinctes téléchargées par user
    SELECT DISTINCT user_id, platform FROM public.plugin_downloads
  ),
  installs AS (  -- 1 ligne par (opener, plateforme) ; sans download → 'unknown'
    SELECT o.user_id, o.first_seen_at, coalesce(up.platform, 'unknown') AS platform
    FROM openers o
    LEFT JOIN user_platforms up ON up.user_id = o.user_id
  ),
  today AS (SELECT (now() AT TIME ZONE 'UTC')::date AS d),
  days AS (SELECT (t.d - g)::date AS day FROM today t, generate_series(0, 89) AS g),
  per_day AS (
    SELECT (first_seen_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n
    FROM installs GROUP BY 1
  )
  SELECT jsonb_build_object(
    'total',        (SELECT count(*) FROM installs),
    'last_7_days',  (SELECT count(*) FROM installs WHERE first_seen_at >= now() - interval '7 days'),
    'last_30_days', (SELECT count(*) FROM installs WHERE first_seen_at >= now() - interval '30 days'),
    'by_platform', jsonb_build_object(
      'mac',     (SELECT count(*) FROM installs WHERE platform = 'mac'),
      'windows', (SELECT count(*) FROM installs WHERE platform = 'windows'),
      'unknown', (SELECT count(*) FROM installs WHERE platform NOT IN ('mac', 'windows'))
    ),
    'daily', (
      SELECT coalesce(
        jsonb_agg(jsonb_build_object('date', to_char(d.day, 'YYYY-MM-DD'), 'count', coalesce(p.n, 0)) ORDER BY d.day),
        '[]'::jsonb)
      FROM days d LEFT JOIN per_day p ON p.day = d.day
    )
  );
$$;

REVOKE ALL ON FUNCTION public.plugin_install_stats(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plugin_install_stats(text[]) TO service_role;
