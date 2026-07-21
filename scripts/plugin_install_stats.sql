-- scripts/plugin_install_stats.sql
-- RPC consommée par api/_stats.js (GET /api/stats/downloads), affichée dans le
-- cockpit Archipel. Appliquée directement sur Supabase (projet GoldeyMusic).
--
-- « Installation » = un utilisateur ayant RÉELLEMENT ouvert le plugin
-- (plugin_first_seen — migration 044). Une install = un opener = une ligne
-- (son OS). La plateforme vient de plugin_first_seen.platform (stockée,
-- migration 048), avec fallback sur le dernier téléchargement loggé, puis
-- 'unknown'. Même notion que la page /admin Versions (les téléchargements
-- bruts ne comptent pas comme installs). Équipe exclue via exclude_emails.
-- Daté à first_seen_at → somme du breakdown quotidien (90 j) == total.
CREATE OR REPLACE FUNCTION public.plugin_install_stats(exclude_emails text[] DEFAULT '{}')
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH ex AS (
    SELECT lower(trim(e)) AS e FROM unnest(coalesce(exclude_emails, '{}')) AS e
  ),
  deduced AS (  -- dernier téléchargement loggé par user (fallback plateforme)
    SELECT DISTINCT ON (user_id) user_id, platform
    FROM public.plugin_downloads
    WHERE platform IN ('mac', 'windows')
    ORDER BY user_id, created_at DESC
  ),
  installs AS (  -- 1 ligne par opener (hors équipe), OS = stocké > déduit > unknown
    SELECT p.user_id, p.first_seen_at,
           coalesce(p.platform, d.platform, 'unknown') AS platform
    FROM public.plugin_first_seen p
    LEFT JOIN deduced d ON d.user_id = p.user_id
    WHERE p.user_id IS NOT NULL
      AND lower(p.email) NOT IN (SELECT e FROM ex)
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
