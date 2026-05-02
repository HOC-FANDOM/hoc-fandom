// ============================================================
// HOC FANDOM - WORKER V6 (Ultra simplifié, localStorage seul)
// Fonctionne avec le plan Free, aucune sécurité côté serveur
// Seule protection : Turnstile anti‑robot
// ============================================================

export default {
  async fetch(request, env) {
    const CONFIG = {
      PROBABILITY: parseFloat(env.PROBABILITY || "0.001"),
      WEIGHT: parseInt(env.WEIGHT || "1000"),
      CACHE_TTL: 60,
      CANDIDATES: ["Abigail","chrisTell","mcdk","meetch","Leila","jalia","manie","natha","layouyou","abee"],
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

    // Maintenance
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
        const { candidateId, token } = body;
        if (!CONFIG.CANDIDATES.includes(candidateId) || !token) {
          return respond({ error: "Invalid data" }, 400, corsHeaders);
        }

        // 1. Vérification Turnstile
        const turnstileRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          body: `secret=${env.TURNSTILE_SECRET}&response=${token}`
        });
        const turnstileData = await turnstileRes.json();
        if (!turnstileData.success) {
          return respond({ error: "Turnstile failed" }, 403, corsHeaders);
        }

        // 2. Enregistrement du vote (échantillonnage pour rester dans les quotas gratuits)
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

function respond(data, status, corsHeaders, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders }
  });
            }
