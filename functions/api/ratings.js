export async function onRequest(context) {
  const { request } = context;

  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const incoming = new URL(request.url);
  const season = incoming.searchParams.get("season") || "2027";

  if (!/^\d{4}$/.test(season)) {
    return new Response("Invalid season", { status: 400 });
  }

  const url = `https://barttorvik.com/${season}_team_results.csv`;

  try {
    const result = await fetch(url);

    if (!result.ok) {
      return new Response("Bart Torvik data unavailable", {
        status: result.status
      });
    }

    const csv = await result.text();

    if (!csv.trim()) {
      return new Response("No ratings data returned", { status: 502 });
    }

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Cache-Control": "public, max-age=300"
      }
    });
  } catch (error) {
    return new Response("Could not connect to Bart Torvik", {
      status: 502
    });
  }
}
