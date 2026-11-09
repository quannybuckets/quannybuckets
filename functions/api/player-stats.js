
const CACHE_SECONDS = 24 * 60 * 60;
const MAX_STALE_SECONDS = 30 * 24 * 60 * 60;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!env.QB_DB) {
    return json({ error: "D1 database unavailable" }, 500);
  }

  const incoming = new URL(request.url);
  const season = incoming.searchParams.get("season") || "2027";

  if (!/^\d{4}$/.test(season)) {
    return json({ error: "Invalid season" }, 400);
  }

  const cacheKey = `player-stats:${season}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    const cached = await env.QB_DB.prepare(`
      SELECT response_body, fetched_at
      FROM api_response_cache
      WHERE cache_key = ?
    `).bind(cacheKey).first();

    // Reuse player data for 24 hours.
    if (cached && now - cached.fetched_at < CACHE_SECONDS) {
      return new Response(cached.response_body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Data-Source": "cache"
        }
      });
    }

    if (!env.CBBD_API_KEY) {
      if (cached) {
        return new Response(cached.response_body, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
            "X-Data-Source": "stale-cache"
          }
        });
      }

      return json({ error: "API key unavailable" }, 500);
    }

    const upstream = new URL(
      "https://api.collegebasketballdata.com/stats/player/season"
    );

    upstream.searchParams.set("season", season);

    let result;

    try {
      result = await fetch(upstream.toString(), {
        headers: {
          Authorization: `Bearer ${env.CBBD_API_KEY}`,
          Accept: "application/json"
        }
      });
    } catch (error) {
      console.error("Player stats API error:", error);
    }

    if (result?.ok) {
      const body = await result.text();

      let parsed;

      try {
        parsed = JSON.parse(body);
      } catch {
        return json({ error: "Invalid player stats JSON" }, 502);
      }

      if (!Array.isArray(parsed)) {
        return json({ error: "Unexpected player stats format" }, 502);
      }

      await env.QB_DB.prepare(`
        INSERT INTO api_response_cache (
          cache_key, response_body, fetched_at
        )
        VALUES (?, ?, ?)
        ON CONFLICT(cache_key)
        DO UPDATE SET
          response_body = excluded.response_body,
          fetched_at = excluded.fetched_at
      `).bind(cacheKey, body, now).run();

      return new Response(body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Data-Source": "upstream"
        }
      });
    }

    // Fall back to previously saved data.
    if (
      cached &&
      now - cached.fetched_at < MAX_STALE_SECONDS
    ) {
      return new Response(cached.response_body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Data-Source": "stale-cache"
        }
      });
    }

    return json({
      error: "Player statistics unavailable",
      upstreamStatus: result?.status || null
    }, result?.status === 429 ? 429 : 502);

  } catch (error) {
  console.error("Player stats cache error:", error);

  return json({
    error: "Could not load player statistics",
    errorType: error?.name || "Unknown",
    errorMessage: String(error?.message || error)
  }, 500);
}
}

