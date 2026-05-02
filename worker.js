// ============================================================
// HOC FANDOM - WORKER V8 (Anti‑bot amélioré, sans domaine)
// Protections : champ caché + rate‑limit 10s + vérification Origin
// ============================================================

export default {
  async fetch(request, env) {
    const CONFIG = {
      PROBABILITY: parseFloat(env.PROBABILITY || "0.001"),
      WEIGHT: parseInt(env.WEIGHT || "1000"),
      CACHE_TTL: 60,
      CANDIDATES: ["Abigail","chrisTell","mcdk","meetch","Leila","jalia","manie","natha","layouyou","abee"],
      VOTE_COOLDOWN_MS: 10000,           // 10 secondes entre deux votes d'un même appareil
      CHALLENGE_SECRET: "hoc2027"        // valeur attendue du champ caché (changez-la si vous voulez)
    };

    const corsHeaders = {
      "Access-Control-Allow-Origin": "https://houseofchallengefandom.pages.dev",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true",
      "X-Content-Type-Options": "nosniff"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);

    if (env.MAINTENANCE === "true") {
      return respond({ maintenance: true }, 503, corsHeaders);
    }

    // GET /results
    if (url.pathname === "/results") {
      try {
        const votes = await Promise.all(
          CONFIG.CANDIDATES.map(id => env.HOC_VOTES.get(id) || "0")
        );
        let total = 0;
        const results = {};
        CONFIG.CANDIDATES.forEach((id, i) => {
          const raw = parseFloat(votes[i]);
          const score = Math.floor(raw * CONFIG.WEIGHT);
          results[id] = { votes: score, percentage: "0.00" };
          total += score;
        });
        if (total > 0) {
          CONFIG.CANDIDATES.forEach(id => {
            results[id].percentage = ((results[id].votes / total) * 100).toFixed(2);
          });
        }
        return respond(results, 200, corsHeaders, {
          "Cache-Control": `public, max-age=${CONFIG.CACHE_TTL}`
        });
      } catch (e) {
        return respond({ error: "KV read error" }, 500, corsHeaders);
      }
    }

    // POST /vote
    if (url.pathname === "/vote" && request.method === "POST") {
      try {
        const body = await request.json();
        const { candidateId, challenge } = body;

        // 0. Vérification de l'origine (bloque les appels directs sans navigateur)
        const origin = request.headers.get("Origin") || "";
        if (!origin.startsWith("https://houseofchallengefandom.pages.dev")) {
          return respond({ error: "Forbidden" }, 403, corsHeaders);
        }

        if (!CONFIG.CANDIDATES.includes(candidateId)) {
          return respond({ error: "Invalid candidate" }, 400, corsHeaders);
        }

        // 1. Vérification du champ caché (anti‑bot)
        if (challenge !== CONFIG.CHALLENGE_SECRET) {
          return respond({ error: "Blocked" }, 403, corsHeaders);
        }

        // 2. Rate‑limit par empreinte (IP + User‑Agent)
        const fingerprint = await getLightFingerprint(request);
        if (!inMemoryRateLimiter(fingerprint, CONFIG.VOTE_COOLDOWN_MS)) {
          return respond({ error: "Too many requests. Wait a few seconds." }, 429, corsHeaders);
        }

        // 3. Enregistrement du vote (échantillonnage)
        if (Math.random() < CONFIG.PROBABILITY) {
          const current = parseFloat(await env.HOC_VOTES.get(candidateId) || "0");
          await env.HOC_VOTES.put(candidateId, (current + 1).toString());
        }

        return respond({ success: true }, 200, corsHeaders);
      } catch (e) {
        return respond({ error: "Server error" }, 500, corsHeaders);
      }
    }

    return new Response("HOC FANDOM Worker Online", { status: 200 });
  }
};

// ═══════════════════════════════════════════════════════
// Rate‑limiter en mémoire
// ═══════════════════════════════════════════════════════
const lastVoteTimestamps = new Map();

function inMemoryRateLimiter(fingerprint, cooldownMs) {
  const now = Date.now();
  const last = lastVoteTimestamps.get(fingerprint);
  if (last && (now - last) < cooldownMs) {
    return false;
  }
  lastVoteTimestamps.set(fingerprint, now);
  return true;
}

// ═══════════════════════════════════════════════════════
// Empreinte légère (IP + UA)
// ═══════════════════════════════════════════════════════
async function getLightFingerprint(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ua = request.headers.get("User-Agent") || "";
  const raw = `${ip}|${ua}`;
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function respond(data, status, corsHeaders, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders }
  });
                                 }
