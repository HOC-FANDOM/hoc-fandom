// ==========================================
// HOC FANDOM - WORKER PROBABILITY ENGINE
// ==========================================

export default {
  async fetch(request, env) {
    // RÉGLAGES TITAN (Modifiables dans le dashboard Cloudflare)
    // Pour 100 000 votes/jour : Prob 0.01 / Weight 100
    // Pour 1 000 000 votes/jour : Prob 0.001 / Weight 1000
    const WRITE_PROBABILITY = parseFloat(env.PROBABILITY || "0.01");
    const VOTE_WEIGHT       = parseInt(env.WEIGHT || "100");
    const COOKIE_SECRET     = env.COOKIE_SECRET || "hoc-fandom-2027-super-secret";
    const ALLOWED_ORIGIN    = "https://houseofchallengefandom.pages.dev";

    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);

    // 1. MODE MAINTENANCE
    const isMaintenance = await env.HOC_KV.get("MAINTENANCE_MODE");
    if (isMaintenance === "true") {
      return Response.json({ maintenance: true }, { headers: corsHeaders });
    }

    // 2. ROUTE : RÉSULTATS (Avec Cache 30s pour supporter le trafic)
    if (url.pathname === "/results") {
      const data = await env.HOC_KV.get("VOTES_DATA", "json") || {};
      const total = Object.values(data).reduce((s, c) => s + (c.votes || 0), 0);
      
      const results = {};
      for (const id in data) {
        results[id] = {
          votes: data[id].votes,
          percentage: total > 0 ? ((data[id].votes / total) * 100).toFixed(2) : "0.00"
        };
      }

      return Response.json(results, {
        headers: { ...corsHeaders, "Cache-Control": "public, max-age=30" }
      });
    }

    // 3. ROUTE : VOTE
    if (url.pathname === "/vote" && request.method === "POST") {
      // A. Vérification du Cookie HMAC (Sécurité anti-triche)
      const cookieHeader = request.headers.get("Cookie") || "";
      const hasVoted = await verifySignature(cookieHeader, COOKIE_SECRET);
      if (hasVoted) {
        return new Response("Already voted", { status: 403, headers: corsHeaders });
      }

      const { candidateId, token } = await request.json();

      // B. Vérification Turnstile (Sécurité anti-bot)
      const turnstile = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `secret=${env.TURNSTILE_SECRET}&response=${token}`
      });
      const tsData = await turnstile.json();
      if (!tsData.success) {
        return new Response("Bot security failed", { status: 403, headers: corsHeaders });
      }

      // C. LE MOTEUR DE PROBABILITÉ (L'astuce pour le 0$)
      if (Math.random() < WRITE_PROBABILITY) {
        let data = await env.HOC_KV.get("VOTES_DATA", "json") || {};
        if (!data[candidateId]) data[candidateId] = { votes: 0 };
        
        // On ajoute le poids (ex: +100) pour compenser les votes non-écrits
        data[candidateId].votes += VOTE_WEIGHT; 
        
        await env.HOC_KV.put("VOTES_DATA", JSON.stringify(data));
      }

      // D. Signature du cookie pour bloquer l'utilisateur jusqu'à minuit (Haiti)
      const expiration = getHaitiMidnight();
      const payload = `voted-${expiration.getTime()}`;
      const signature = await hmacSign(payload, COOKIE_SECRET);
      const cookieValue = `${payload}.${signature}`;

      const headers = new Headers(corsHeaders);
      headers.append("Set-Cookie", `hoc_voted=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=None; Expires=${expiration.toUTCString()}`);
      
      return Response.json({ success: true }, { headers });
    }

    return new Response("Not Found", { status: 404 });
  }
};

// --- FONCTIONS DE SÉCURITÉ ---

async function hmacSign(message, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

async function verifySignature(cookieHeader, secret) {
  const match = cookieHeader.match(/hoc_voted=([^;]+)/);
  if (!match) return false;
  const [payload, sig] = match[1].split(".");
  if (!payload || !sig) return false;
  const expectedSig = await hmacSign(payload, secret);
  return expectedSig === sig;
}

function getHaitiMidnight() {
  const now = new Date();
  const haiti = new Date(now.toLocaleString("en-US", { timeZone: "America/Port-au-Prince" }));
  const midnight = new Date(haiti);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 0, 0);
  // Retourner en temps universel pour le cookie
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(midnight.getTime() + offset);
}
