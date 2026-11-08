
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

  const upstream = new URL(
    "https://api.collegebasketballdata.com/recruiting/players"
  );

  for (const key of ["year", "team", "conference", "position"]) {
    const value = incoming.searchParams.get(key);

    if (value) {
      upstream.searchParams.set(key, value);
    }
  }

  const result = await fetch(upstream, {
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
}
