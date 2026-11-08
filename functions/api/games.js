
const CACHE_SECONDS = 300; // 5 minutes
const MAX_STALE_SECONDS = 86400; // 24 hours

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!env.CBBD_API_KEY || !env.QB_DB) {
    return json({ error: "API key or database unavailable" }, 500);
  }

  try {
    const incoming = new URL(request.url);
    const upstream = new URL(
      "https://api.collegebasketballdata.com/games"
    );

    // Normalize the requested dates to calendar days.
    // This prevents different timestamps from creating
    // separate cache entries for the same date range.
    const params = new URLSearchParams(incoming.searchParams);

    for (const key of ["startDateRange", "endDateRange"]) {
      const value = params.get(key);

      if (value) {
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
    }

    params.sort();

    upstream.search = params.toString();

    const cacheKey = `games:${upstream.search}`;
    const now = Math.floor(Date.now() / 1000);

    const cached = await env.QB_DB.prepare(`
      SELECT response_body, fetched_at
      FROM api_response_cache
      WHERE cache_key = ?
    `).bind(cacheKey).first();

    // Return fresh cached data without calling the API.
    if (cached && now - cached.fetched_at < CACHE_SECONDS) {
      return new Response(cached.response_body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Data-Source": "cache"
        }
      });
    }

    let upstreamResponse;

    try {
      upstreamResponse = await fetch(upstream.toString(), {
        headers: {
          Authorization: `Bearer ${env.CBBD_API_KEY}`,
          Accept: "application/json"
        }
      });
    } catch (error) {
      console.error("Games API network error:", error);
    }

    if (upstreamResponse?.ok) {
      const body = await upstreamResponse.text();

      // Save only valid JSON arrays.
      let parsed;

      try {
        parsed = JSON.parse(body);
      } catch {
        return json({ error: "Invalid upstream JSON" }, 502);
      }

      if (!Array.isArray(parsed)) {
        return json({ error: "Unexpected upstream response" }, 502);
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

    // If the upstream API fails, reuse recent saved data.
    if (
      cached &&
      now - cached.fetched_at < MAX_STALE_SECONDS
    ) {
      return new Response(cached.response_body, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Data-Source": "stale-cache",
          "X-Upstream-Status": String(
            upstreamResponse?.status || "network-error"
          )
        }
      });
    }

 let upstreamError = null;

if (upstreamResponse?.status === 429) {
  try {
    upstreamError = (
      await upstreamResponse.text()
    ).slice(0, 300);
  } catch (error) {
    console.error("Could not read upstream error:", error);
    upstreamError = "Response body unavailable";
  }
}
return json({
  error: "Games API unavailable",
  upstreamStatus: upstreamResponse?.status || null,
  upstreamError,
  rateLimit: {
    limit: upstreamResponse?.headers.get("x-ratelimit-limit") || null,
    remaining: upstreamResponse?.headers.get("x-ratelimit-remaining") || null,
    reset: upstreamResponse?.headers.get("x-ratelimit-reset") || null,
    retryAfter: upstreamResponse?.headers.get("retry-after") || null
  }
}, upstreamResponse?.status === 429 ? 429 : 502);


 } catch (error) {
  console.error("Games API error:", error);

  return json({
    error: "Could not load games",
    errorType: error?.name || "UnknownError"
  }, 500);
}
}

