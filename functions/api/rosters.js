const CACHE_SECONDS = 24 * 60 * 60;
const MAX_STALE_SECONDS = 30 * 24 * 60 * 60;
const CACHE_CHUNK_SIZE = 500_000;

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}

function dataResponse(body, source) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Data-Source": source
    }
  });
}

async function saveChunkedCache(env, cacheKey, body, now) {
  const chunks = [];

  for (let i = 0; i < body.length; i += CACHE_CHUNK_SIZE) {
    chunks.push(body.slice(i, i + CACHE_CHUNK_SIZE));
  }

  const statements = [
    env.QB_DB.prepare(`
      DELETE FROM api_response_cache_chunks
      WHERE cache_key = ?
    `).bind(cacheKey),

    ...chunks.map((chunk, index) =>
      env.QB_DB.prepare(`
        INSERT INTO api_response_cache_chunks (
          cache_key,
          chunk_index,
          response_chunk,
          fetched_at
        )
        VALUES (?, ?, ?, ?)
      `).bind(cacheKey, index, chunk, now)
    )
  ];

  await env.QB_DB.batch(statements);
}

async function loadChunkedCache(env, cacheKey) {
  const result = await env.QB_DB.prepare(`
    SELECT chunk_index, response_chunk, fetched_at
    FROM api_response_cache_chunks
    WHERE cache_key = ?
    ORDER BY chunk_index ASC
  `).bind(cacheKey).all();

  const rows = result.results || [];

  if (!rows.length) return null;

  const timestamp = rows[0].fetched_at;

  for (let i = 0; i < rows.length; i++) {
    if (
      Number(rows[i].chunk_index) !== i ||
      rows[i].fetched_at !== timestamp
    ) {
      return null;
    }
  }

  const body = rows
    .map(row => row.response_chunk)
    .join("");

  try {
    if (!Array.isArray(JSON.parse(body))) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    response_body: body,
    fetched_at: timestamp
  };
}

async function loadCache(env, cacheKey) {
  // Prefer chunked cache data for large responses.
  const chunked = await loadChunkedCache(env, cacheKey);

  if (chunked) {
    return chunked;
  }

  // Maintain compatibility with existing cache entries.
  const cached = await env.QB_DB.prepare(`
    SELECT response_body, fetched_at
    FROM api_response_cache
    WHERE cache_key = ?
  `).bind(cacheKey).first();

  return cached || null;
}

async function saveCache(env, cacheKey, body, now) {
  if (body.length > CACHE_CHUNK_SIZE) {
    await saveChunkedCache(env, cacheKey, body, now);

    // Remove the older unchunked entry.
    await env.QB_DB.prepare(`
      DELETE FROM api_response_cache
      WHERE cache_key = ?
        AND fetched_at <= ?
    `).bind(cacheKey, now).run();

  } else {
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

    await env.QB_DB.prepare(`
      DELETE FROM api_response_cache_chunks
      WHERE cache_key = ?
        AND fetched_at <= ?
    `).bind(cacheKey, now).run();
  }
}

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return json({
      error: "Method not allowed"
    }, 405);
  }

  if (!env.QB_DB) {
    return json({
      error: "D1 database unavailable"
    }, 500);
  }

  const incoming = new URL(request.url);
  const season = incoming.searchParams.get("season") || "2027";
  const team = incoming.searchParams.get("team") || "";

  if (!/^\d{4}$/.test(season)) {
    return json({
      error: "Invalid season"
    }, 400);
  }

  const cacheKey = `rosters:${season}:${team}`;
  const now = Math.floor(Date.now() / 1000);

  let activeCache = null;

  try {
    activeCache = await loadCache(env, cacheKey);
  } catch (error) {
    console.error("Roster cache read error:", error);
  }

  // Use cached data for 24 hours.
  if (
    activeCache &&
    now - activeCache.fetched_at < CACHE_SECONDS
  ) {
    return dataResponse(
      activeCache.response_body,
      "cache"
    );
  }

  // Fall back to saved data if the API key is missing.
  if (!env.CBBD_API_KEY) {
    if (
      activeCache &&
      now - activeCache.fetched_at < MAX_STALE_SECONDS
    ) {
      return dataResponse(
        activeCache.response_body,
        "stale-cache"
      );
    }

    return json({
      error: "API key unavailable"
    }, 500);
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
      return json({
        error: "Invalid roster JSON"
      }, 502);
    }

    if (!Array.isArray(parsed)) {
      return json({
        error: "Unexpected roster format"
      }, 502);
    }

    try {
      await saveCache(env, cacheKey, body, now);
    } catch (error) {
      console.error("Roster cache write error:", error);
    }

    return dataResponse(body, "upstream");
  }

  // Return stale cached data when upstream fails.
  if (
    activeCache &&
    now - activeCache.fetched_at < MAX_STALE_SECONDS
  ) {
    return dataResponse(
      activeCache.response_body,
      "stale-cache"
    );
  }

  return json({
    error: "Rosters unavailable",
    upstreamStatus: result?.status || null
  }, result?.status === 429 ? 429 : 502);
}
