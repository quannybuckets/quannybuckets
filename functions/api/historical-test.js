
export async function onRequestGet() {
  const url =
    'https://barttorvik.com/trank.php?year=2026&begin=20251103&end=20251108';

  try {
    const response = await fetch(url);
    const html = await response.text();

    return Response.json({
      status: response.status,
      length: html.length,
      containsMichigan: html.includes('Michigan'),
      containsAdjOE: html.includes('ADJOE')
    });
  } catch (error) {
    return Response.json({
      error: error.message
    }, { status: 500 });
  }
}
