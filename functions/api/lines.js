
const CACHE_SECONDS = 5 * 60;
const MAX_STALE_SECONDS = 60 * 60;

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

  try {
    const incoming = new URL(request.url);
    const upstream = new URL(
      "https://api.collegebasketballdata.com/lines"
    );

    const params = new URLSearchParams(incoming.searchParams);

    // Normalize date ranges so changing timestamps
    // don't generate unnecessary cache entries.
    for (const key of ["startDateRange", "endDateRange"]) {
      const value = params.get(key);

      if (!value) continue;

      const date = new Date(value);

      if (Number.isNaN(date.getTime())) {
        return json({ error: "Invalid date range" }, 400);
      }

      if (key === "startDateRange") {
        date.setUTCHours(0, 0, 0, 0);
      } else {
        date.setUTCHours(23, 59, 59, 999);
      }

      params.set(key, date.toISOString());
    }

    params.sort();
    upstream.search = params.toString();

    const cacheKey = `lines:${upstream.search}`;
    const now = Math.floor(Date.now() / 1000);

    const cached = await env.QB_DB.prepare(`
      SELECT response_body, fetched_at
      FROM api_response_cache
      WHERE cache_key = ?
    `).bind(cacheKey).first();

    // Return fresh cached odds.
    if (cached && now - cached.fetched_at < CACHE_SECONDS) {
      return cachedResponse(cached.response_body, "cache");
    }

    // If the API key is unavailable, use recent saved data.
    if (!env.CBBD_API_KEY) {
      if (
        cached &&
        now - cached.fetched_at < MAX_STALE_SECONDS
      ) {
        return cachedResponse(
          cached.response_body,
          "stale-cache"
        );
      }

      return json({ error: "API key unavailable" }, 500);
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
      console.error("Sportsbook lines API error:", error);
    }

    if (result?.ok) {
      const body = await result.text();

      let parsed;

      try {
        parsed = JSON.parse(body);
      } catch {
        return json({ error: "Invalid sportsbook JSON" }, 502);
      }

      if (!Array.isArray(parsed)) {
        return json({
          error: "Unexpected sportsbook response"
        }, 502);
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

    // Use saved odds temporarily if the API fails.
    if (
      cached &&
      now - cached.fetched_at < MAX_STALE_SECONDS
    ) {
      return cachedResponse(
        cached.response_body,
        "stale-cache"
      );
    }

    return json({
      error: "Sportsbook lines unavailable",
      upstreamStatus: result?.status || null
    }, result?.status === 429 ? 429 : 502);

  } catch (error) {
    console.error("Sportsbook cache error:", error);

    return json({
      error: "Could not load sportsbook lines"
    }, 500);
  }
}
