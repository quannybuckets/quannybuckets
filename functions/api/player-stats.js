
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
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Data-Source": source
    }
  });
}

// Save large responses in smaller D1 chunks.
async function saveChunkedCache(env, cacheKey, body, now) {
  const chunks = [];

  for (
    let i = 0;
    i < body.length;
    i += CACHE_CHUNK_SIZE
  ) {
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

// Load a cached response from D1 chunks.
async function loadChunkedCache(env, cacheKey) {
  const result = await env.QB_DB.prepare(`
    SELECT chunk_index, response_chunk, fetched_at
    FROM api_response_cache_chunks
    WHERE cache_key = ?
    ORDER BY chunk_index ASC
  `).bind(cacheKey).all();

  const rows = result.results || [];

  if (rows.length === 0) {
    return null;
  }

  const expectedTimestamp = rows[0].fetched_at;

  // Verify chunk ordering and consistency.
  for (let i = 0; i < rows.length; i++) {
    if (
      Number(rows[i].chunk_index) !== i ||
      rows[i].fetched_at !== expectedTimestamp ||
      typeof rows[i].response_chunk !== "string"
    ) {
      return null;
    }
  }

  // Reassemble the original JSON string.
  // Avoid parsing the entire dataset again.
  const body = rows
    .map(row => row.response_chunk)
    .join("");

  return {
    response_body: body,
    fetched_at: expectedTimestamp
  };
}

// Load only the newest available cache format.
async function loadCache(env, cacheKey) {
  // Read timestamps first, not large response bodies.
  const chunkMetadata = await env.QB_DB.prepare(`
    SELECT MAX(fetched_at) AS fetched_at
    FROM api_response_cache_chunks
    WHERE cache_key = ?
  `).bind(cacheKey).first();

  const legacyMetadata = await env.QB_DB.prepare(`
    SELECT fetched_at
    FROM api_response_cache
    WHERE cache_key = ?
  `).bind(cacheKey).first();

  const chunkTime = Number(
    chunkMetadata?.fetched_at || 0
  );

  const legacyTime = Number(
    legacyMetadata?.fetched_at || 0
  );

  // Prefer chunked cache if equally recent or newer.
  if (chunkTime && chunkTime >= legacyTime) {
    const chunked = await loadChunkedCache(
      env,
      cacheKey
    );

    if (chunked) {
      return chunked;
    }
  }

  // Read the legacy body only if needed.
  if (legacyTime) {
    const legacy = await env.QB_DB.prepare(`
      SELECT response_body, fetched_at
      FROM api_response_cache
      WHERE cache_key = ?
    `).bind(cacheKey).first();

    if (legacy) {
      return legacy;
    }
  }

  // Last fallback to chunked data.
  if (chunkTime) {
    return await loadChunkedCache(env, cacheKey);
  }

  return null;
}

// Save responses using the appropriate cache format.
async function saveCache(env, cacheKey, body, now) {
  if (body.length > CACHE_CHUNK_SIZE) {
    await saveChunkedCache(
      env,
      cacheKey,
      body,
      now
    );

    // Remove older legacy cache entries.
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

    // Remove older chunked cache entries.
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

  const season =
    incoming.searchParams.get("season") || "2027";

  if (!/^\d{4}$/.test(season)) {
    return json({
      error: "Invalid season"
    }, 400);
  }

  const cacheKey = `player-stats:${season}`;

  const now = Math.floor(
    Date.now() / 1000
  );

  let activeCache = null;

  // Attempt to load the cache.
  try {
    activeCache = await loadCache(
      env,
      cacheKey
    );
  } catch (error) {
    console.error(
      "Player stats cache read error:",
      error
    );
  }

  // Return fresh cached data immediately.
  if (
    activeCache &&
    now - Number(activeCache.fetched_at) < CACHE_SECONDS
  ) {
    return dataResponse(
      activeCache.response_body,
      "cache"
    );
  }

  // Handle missing API credentials.
  if (!env.CBBD_API_KEY) {
    if (
      activeCache &&
      now - Number(activeCache.fetched_at) <
        MAX_STALE_SECONDS
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
    "https://api.collegebasketballdata.com/stats/player/season"
  );

  upstream.searchParams.set(
    "season",
    season
  );

  let result = null;

  // Fetch player statistics from CollegeBasketballData.
  try {
    result = await fetch(
      upstream.toString(),
      {
        headers: {
          Authorization:
            `Bearer ${env.CBBD_API_KEY}`,
          Accept: "application/json"
        }
      }
    );
  } catch (error) {
    console.error(
      "Player stats upstream error:",
      error
    );
  }

  // Process successful upstream responses.
  if (result?.ok) {
    try {
      const body = await result.text();

      // Validate new upstream data before caching.
      let parsed;

      try {
        parsed = JSON.parse(body);
      } catch {
        return json({
          error: "Invalid player stats JSON"
        }, 502);
      }

      if (!Array.isArray(parsed)) {
        return json({
          error: "Unexpected player stats format"
        }, 502);
      }

      // Release the parsed reference before saving.
      parsed = null;

      // A cache write failure should not prevent
      // returning valid upstream data.
      try {
        await saveCache(
          env,
          cacheKey,
          body,
          now
        );
      } catch (error) {
        console.error(
          "Player stats cache write error:",
          error
        );
      }

      return dataResponse(
        body,
        "upstream"
      );

    } catch (error) {
      console.error(
        "Player stats processing error:",
        error
      );
    }
  }

  // Fall back to cached data if the API fails.
  if (
    activeCache &&
    now - Number(activeCache.fetched_at) <
      MAX_STALE_SECONDS
  ) {
    return dataResponse(
      activeCache.response_body,
      "stale-cache"
    );
  }

  return json({
    error: "Player statistics unavailable",
    upstreamStatus: result?.status || null
  }, result?.status === 429 ? 429 : 502);
}


