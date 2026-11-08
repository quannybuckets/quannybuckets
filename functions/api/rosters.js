
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

function cachedResponse(body, source) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Data-Source": source
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
  const team = incoming.searchParams.get("team") || "";

  if (!/^\d{4}$/.test(season)) {
    return json({ error: "Invalid season" }, 400);
  }

  const cacheKey = `rosters:${season}:${team}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    const cached = await env.QB_DB.prepare(`
      SELECT response_body, fetched_at
      FROM api_response_cache
      WHERE cache_key = ?
    `).bind(cacheKey).first();

    // Reuse roster data for 24 hours.
    if (cached && now - cached.fetched_at < CACHE_SECONDS) {
      return cachedResponse(cached.response_body, "cache");
    }

    // If the API key is unavailable, use saved data.
    if (!env.CBBD_API_KEY) {
      if (
        cached &&
        now - cached.fetched_at < MAX_STALE_SECONDS
      ) {
        return cachedResponse(cached.response_body, "stale-cache");
      }

      return json({ error: "API key unavailable" }, 500);
    }

    const upstream = new URL(
      "https://api.collegebasketballdata.com/teams/roster"
    );

    upstream.searchParams.set("season", season);

    if (team) {
      upstream.searchParams.set("team", team);
    }

    let result;

    try {
      result = await fetch(upstream.toString(), {
        headers: {
          Authorization: `Bearer ${env.CBBD_API_KEY}`,
          Accept: "application/json"
        }
      });
    } catch (error) {
      console.error("Roster API network error:", error);
    }

    if (result?.ok) {
      const body = await result.text();

      let parsed;

      try {
        parsed = JSON.parse(body);
      } catch {
        return json({ error: "Invalid roster JSON" }, 502);
      }

      if (!Array.isArray(parsed)) {
        return json({ error: "Unexpected roster format" }, 502);
      }

      await env.QB_DB.prepare(`
        INSERT INTO api_response_cache (
          cache_key,
          response_body,
          fetched_at
        )
        VALUES (?, ?, ?)
        ON CONFLICT(cache_key)
        DO UPDATE SET
          response_body = excluded.response_body,
          fetched_at = excluded.fetched_at
      `).bind(cacheKey, body, now).run();

      return cachedResponse(body, "upstream");
    }

    // Reuse saved data if the upstream API fails.
    if (
      cached &&
      now - cached.fetched_at < MAX_STALE_SECONDS
    ) {
      return cachedResponse(cached.response_body, "stale-cache");
    }

    return json({
      error: "Rosters unavailable",
      upstreamStatus: result?.status || null
    }, result?.status === 429 ? 429 : 502);

  } catch (error) {
    console.error("Roster cache error:", error);

    return json({
      error: "Could not load rosters"
    }, 500);
  }
}
