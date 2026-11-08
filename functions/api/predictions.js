
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

function validString(value, max = 300) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max;
}

function validNumber(value) {
  return typeof value === "number" &&
    Number.isFinite(value);
}

// Retrieve saved predictions
export async function onRequestGet({ env }) {
  try {
    if (!env.QB_DB) {
      return json({ error: "QB_DB binding unavailable" }, 500);
    }

    const result = await env.QB_DB.prepare(`
      SELECT *
      FROM game_predictions
      ORDER BY start_time DESC
      LIMIT 1000
    `).all();

    return json({
      predictions: result.results || []
    });
  } catch (error) {
    console.error("Prediction retrieval failed:", error);
    return json({ error: "Could not retrieve predictions" }, 500);
  }
}

// Save predictions or grade completed games
export async function onRequestPost({ request, env }) {
    const expectedToken = env.PREDICTIONS_WRITE_TOKEN;
  const providedToken = request.headers.get("X-Predictions-Token");

  if (!expectedToken) {
    return json({ error: "Write authentication not configured" }, 503);
  }

  if (providedToken !== expectedToken) {
    return json({ error: "Unauthorized" }, 401);
  }try {
    if (!env.QB_DB) {
      return json({ error: "QB_DB binding unavailable" }, 500);
    }

    const body = await request.json();

    // SAVE ORIGINAL PREGAME PREDICTIONS
if (body.action === "save") {
  if (!Array.isArray(body.predictions) ||
      body.predictions.length > 1000) {
    return json({ error: "Invalid predictions list" }, 400);
  }

      let saved = 0;
      let skipped = 0;

      for (const p of body.predictions) {
        const start = Date.parse(p.start_time);

        if (
          !validString(p.game_key) ||
          !validString(p.away_team, 100) ||
          !validString(p.home_team, 100) ||
          !validString(p.model_pick, 100) ||
          !Number.isInteger(p.season) ||
          !validNumber(p.projected_away_score) ||
          !validNumber(p.projected_home_score) ||
          !validNumber(p.projected_spread) ||
          !validNumber(p.projected_total) ||
          !Number.isFinite(start) ||
          start <= Date.now() ||
          ![p.away_team, p.home_team, "Pick’em"].includes(p.model_pick)
        ) {
          skipped++;
          continue;
        }

        const result = await env.QB_DB.prepare(`
          INSERT OR IGNORE INTO game_predictions (
            game_key,
            season,
            start_time,
            away_team,
            home_team,
            projected_away_score,
            projected_home_score,
            projected_spread,
            projected_total,
            model_pick
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          p.game_key,
          p.season,
          new Date(start).toISOString(),
          p.away_team,
          p.home_team,
          p.projected_away_score,
          p.projected_home_score,
          p.projected_spread,
          p.projected_total,
          p.model_pick
        ).run();

        if (result.meta?.changes > 0) {
          saved++;
        } else {
          skipped++;
        }
      }

      return json({ success: true, saved, skipped });
    }

    // GRADE GAMES AFTER FINAL SCORES ARRIVE
    if (body.action === "grade") {
      if (!Array.isArray(body.results) ||
          body.results.length > 500) {
        return json({ error: "Invalid results list" }, 400);
      }

      let graded = 0;

      for (const game of body.results) {
        if (
          !validString(game.game_key) ||
          String(game.status).toLowerCase() !== "final" ||
          !Number.isInteger(game.away_score) ||
          !Number.isInteger(game.home_score) ||
          game.away_score < 0 ||
          game.home_score < 0
        ) {
          continue;
        }

        if (game.away_score === game.home_score) {
          continue;
        }

        const winner = game.away_score > game.home_score
          ? game.away_team
          : game.home_team;

        const result = await env.QB_DB.prepare(`
          UPDATE game_predictions
          SET
            actual_away_score = ?,
            actual_home_score = ?,
            actual_status = 'final',
            winner_correct = CASE
              WHEN model_pick = 'Pick’em' THEN NULL
              WHEN model_pick = ? THEN 1
              ELSE 0
            END,
            graded_at = CURRENT_TIMESTAMP
          WHERE game_key = ?
            AND start_time <= ?
        `).bind(
          game.away_score,
          game.home_score,
          winner,
          game.game_key,
          new Date().toISOString()
        ).run();

        graded += result.meta?.changes || 0;
      }

      return json({ success: true, graded });
    }

    return json({ error: "Unknown action" }, 400);

  } catch (error) {
    console.error("Prediction API error:", error);
    return json({ error: "Prediction database operation failed" }, 500);
  }
}
