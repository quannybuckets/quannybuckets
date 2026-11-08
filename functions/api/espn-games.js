
export async function onRequest({ request }) {
  const incoming = new URL(request.url);

  const date = incoming.searchParams.get("date");

  if (!date || !/^\d{8}$/.test(date)) {
    return Response.json(
      { error: "Use date=YYYYMMDD" },
      { status: 400 }
    );
  }

  const upstream = new URL(
    "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard"
  );

  upstream.searchParams.set("dates", date);
  upstream.searchParams.set("limit", "500");
  upstream.searchParams.set("groups", "50");

  try {
    const response = await fetch(upstream.toString(), {
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      return Response.json(
        { error: "ESPN unavailable", status: response.status },
        { status: 502 }
      );
    }

    const data = await response.json();

    return Response.json({
      date,
      count: data.events?.length || 0,
      events: data.events || []
    });
  } catch (error) {
    console.error("ESPN API error:", error);

    return Response.json(
      { error: "Could not load ESPN games" },
      { status: 502 }
    );
  }
}
