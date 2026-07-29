export function installerUnavailableResponse() {
  return new Response(null, {
    status: 410,
    headers: {
      "Cache-Control": "public, max-age=300",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}
