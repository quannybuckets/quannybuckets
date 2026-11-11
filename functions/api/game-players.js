
export async function onRequestGet({ request, env }) {
  if (!env.CBBD_API_KEY) {
    return Response.json(
      { error: 'CBBD_API_KEY is not configured' },
      { status: 503 }
    );
  }

  const url = new URL(request.url);

  const start = url.searchParams.get('startDateRange');
  const end = url.searchParams.get('endDateRange');

  const valid = /^\d{4}-\d{2}-\d{2}$/;

  if (!valid.test(start || '') || !valid.test(end || '')) {
    return Response.json(
      {
        error: 'Provide startDateRange and endDateRange as YYYY-MM-DD'
      },
      { status: 400 }
    );
  }

  const a = new Date(start + 'T00:00:00Z');
  const b = new Date(end + 'T00:00:00Z');

  if (
    !Number.isFinite(+a) ||
    !Number.isFinite(+b) ||
    b < a ||
    b - a > 31 * 86400000 ||
    b > new Date()
  ) {
    return Response.json(
      {
        error: 'Dates must be historical, ordered, and at most 31 days apart'
      },
      { status: 400 }
    );
  }

  const upstream = new URL(
    'https://api.collegebasketballdata.com/games/players'
  );

  upstream.searchParams.set('startDateRange', start);
  upstream.searchParams.set('endDateRange', end);

  try {
    const response = await fetch(upstream, {
      headers: {
        Authorization: `Bearer ${env.CBBD_API_KEY}`,
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      return Response.json(
        {
          error: 'Upstream request failed',
          upstreamStatus: response.status
        },
        { status: response.status === 429 ? 429 : 502 }
      );
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      return Response.json(
        { error: 'Unexpected upstream response' },
        { status: 502 }
      );
    }

    return Response.json(data, {
      headers: {
        'Cache-Control': 'private, max-age=0',
        'X-Robots-Tag': 'noindex'
      }
    });

  } catch (err) {
    return Response.json(
      { error: 'Unable to retrieve game-level player data' },
      { status: 502 }
    );
  }
}
