
const CACHE_SECONDS = 24 * 60 * 60;
const MAX_STALE_SECONDS = 30 * 24 * 60 * 60;

function csvResponse(body, source) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Data-Source": source
    }
  });
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return new Response("Method not allowed", {
      status: 405
    });
  }

  const incoming = new URL(request.url);
  const season = incoming.searchParams.get("season") || "2027";

  if (!/^\d{4}$/.test(season)) {
    return new Response("Invalid season", {
      status: 400
    });
  }

  if (!env.QB_DB) {
    return new Response("D1 database unavailable", {
      status: 500
    });
  }

  const cacheKey = `ratings:${season}`;
  const now = Math.floor(Date.now() / 1000);

  try {
    const cached = await env.QB_DB.prepare(`
      SELECT response_body, fetched_at
      FROM api_response_cache
      WHERE cache_key = ?
    `).bind(cacheKey).first();

    // Reuse ratings for 24 hours.
    if (
      cached &&
      now - cached.fetched_at < CACHE_SECONDS
    ) {
      return csvResponse(cached.response_body, "cache");
    }

    const url =
      `https://barttorvik.com/${season}_team_results.csv`;

    let result;

    try {
      result = await fetch(url);
    } catch (error) {
      console.error("Bart Torvik network error:", error);
    }

    if (result?.ok) {
      const csv = await result.text();

      // Validate before storing.
      const firstLine = csv.trim().split(/\r?\n/)[0] || "";

      if (
        !csv.trim() ||
        !firstLine.includes("team") ||
        !firstLine.includes("adjoe") ||
        !firstLine.includes("adjde")
      ) {
        return new Response(
          "Invalid Bart Torvik ratings data",
          { status: 502 }
        );
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
      `).bind(cacheKey, csv, now).run();

      return csvResponse(csv, "upstream");
    }

    // Use saved ratings if Bart Torvik is unavailable.
    if (
      cached &&
      now - cached.fetched_at < MAX_STALE_SECONDS
    ) {
      return csvResponse(
        cached.response_body,
        "stale-cache"
      );
    }

    return new Response(
      "Bart Torvik ratings unavailable",
      { status: result?.status || 502 }
    );

  } catch (error) {
    console.error("Ratings cache error:", error);

    return new Response(
      "Could not load ratings",
      { status: 500 }
    );
  }
}

