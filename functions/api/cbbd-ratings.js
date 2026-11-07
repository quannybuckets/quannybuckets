export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!env.CBBD_API_KEY) {
    return Response.json(
      { error: "Basketball data API key is not configured." },
      { status: 500 }
    );
  }

  const incoming = new URL(request.url);
  const season = incoming.searchParams.get("season") || "2027";
  const type = incoming.searchParams.get("type") || "adjusted";

  const allowedTypes = ["adjusted", "srs", "elo"];

  if (!/^\d{4}$/.test(season) || !allowedTypes.includes(type)) {
    return new Response("Invalid season or ratings type", {
      status: 400
    });
  }

  const url = new URL(
    `https://api.collegebasketballdata.com/ratings/${type}`
  );

  url.searchParams.set("season", season);

  try {
    const result = await fetch(url, {
      headers: {
        Authorization: `Bearer ${env.CBBD_API_KEY}`,
        Accept: "application/json"
      }
    });

    return new Response(await result.text(), {
      status: result.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300"
      }
    });
  } catch (error) {
    return new Response("Could not connect to CBBD ratings", {
      status: 502
    });
  }
}
