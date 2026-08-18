/*
 * Cidade Labs — Bus Works · live positions proxy (Cloudflare Worker)
 *
 * Why this exists: the browser can't call itranvias.com directly (CSP/CORS).
 * A Worker is a server, so it can. It fetches every line from iTranvias,
 * reshapes the buses into the app's contract, and serves one CORS-enabled
 * JSON that the map reads in place of the simulated data/buses.json.
 *
 * Contract returned (matches simulate-buses.js):
 *   { updated: <ms>, buses: [ { line, lat, lon, status } ] }
 *
 * Deploy: paste into a new Worker at dash.cloudflare.com (Workers & Pages →
 * Create → Worker), or `wrangler deploy`. No API key needed.
 */

// A Coruña line IDs. iTranvias keys buses by an internal line id (`dato`).
// The GTFS route_short_names are "1","1A",... but the live endpoint's `dato`
// values are the ones below (600 was confirmed working in testing). These are
// our best-known set; any that 404 or return empty are skipped gracefully, and
// we log which succeeded so the list can be corrected against real responses.
const LINES = [
  "1","2","3","3A","4","5","6","6A","7","11","12","12A",
  "14","17","20","21","22","23","23A","24","B","BuhoBus"
];
// Some deployments use numeric ids (e.g. 600). If the short-name calls return
// nothing, swap this list for the numeric ids discovered from the real feed.

const ITR = (dato) =>
  `https://itranvias.com/queryitr_v3.php?func=99&mostrar=B&dato=${encodeURIComponent(dato)}`;

const CACHE_SECONDS = 8;   // be polite to iTranvias; one fetch cycle per ~8s

export default {
  async fetch(request, env, ctx) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": `public, max-age=${CACHE_SECONDS}`,
      "Content-Type": "application/json; charset=utf-8",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // edge cache: serve a cached bundle if fresh, else rebuild
    const cache = caches.default;
    const cacheKey = new Request(new URL(request.url).origin + "/buses", request);
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const buses = [];
    const okLines = [];

    // fetch all lines in parallel
    const results = await Promise.allSettled(
      LINES.map((dato) =>
        fetch(ITR(dato), { cf: { cacheTtl: CACHE_SECONDS } })
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => ({ dato, data }))
      )
    );

    for (const res of results) {
      if (res.status !== "fulfilled" || !res.value || !res.value.data) continue;
      const { dato, data } = res.value;
      const extracted = extractBuses(data, dato);
      if (extracted.length) okLines.push(dato);
      buses.push(...extracted);
    }

    const body = JSON.stringify({
      updated: Date.now(),
      lines_ok: okLines,      // which line ids returned buses (for debugging)
      count: buses.length,
      buses,
    });

    const response = new Response(body, { headers: cors });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

/*
 * Reshape one iTranvias line response into contract buses.
 * Observed shape (line 600 test):
 *   { resultado:"OK", mapas:[ { buses:[ { sentido:"1", buses:[
 *        { bus:342, posx:-8.45073, posy:43.344245 } ] } ] } ] }
 * posx = longitude, posy = latitude.
 */
function extractBuses(data, dato) {
  const out = [];
  const mapas = data && data.mapas;
  if (!Array.isArray(mapas)) return out;
  for (const mapa of mapas) {
    const dirs = mapa && mapa.buses;
    if (!Array.isArray(dirs)) continue;
    for (const dir of dirs) {
      const sentido = dir && dir.sentido;
      const list = dir && dir.buses;
      if (!Array.isArray(list)) continue;
      for (const b of list) {
        if (typeof b.posx !== "number" || typeof b.posy !== "number") continue;
        out.push({
          line: String(dato),
          lat: b.posy,
          lon: b.posx,
          status: "moving",   // refine later with func=2 state if desired
          dir: sentido != null ? String(sentido) : undefined,
        });
      }
    }
  }
  return out;
}
