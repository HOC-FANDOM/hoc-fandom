// ============================================================
// HOC FANDOM - WORKER TITAN UNIFIED (JSON Edition)
// ============================================================

export default {
  async fetch(request, env) {
    // RÉGLAGES RÉCUPÉRÉS DEPUIS LE DASHBOARD CLOUDFLARE
    const WRITE_PROBABILITY = parseFloat(env.PROBABILITY || "0.01");
    const VOTE_WEIGHT       = parseInt(env.WEIGHT || "100");
    const COOKIE_SECRET     = env.COOKIE_SECRET || "hoc2027-change-moi-vite";
    const ALLOWED_ORIGIN    = "https://houseofchallengefandom.pages.dev";

    const CANDIDATES = [
      "Abigail", "chrisTell", "mcdk", "meetch",
      "Leila", "jalia", "manie", "natha", "layouyou", "abee"
    ];

    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Credentials": "true",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const url = new URL(request.url);

    // 1. VÉRIFICATION MAINTENANCE
    const isMaintenance = await env.HOC_VOTES.get("MAINTENANCE_MODE");
    if (isMaintenance === "true") {
      return Response.json({ maintenance: true }, { headers: corsHeaders });
    }

    // 2. ROUTE : RÉSULTATS (Lecture unique du JSON)
    if (url.pathname === "/results") {
      const data = await env.HOC_VOTES.get("VOTES_DATA", "json") || {};
      
      let totalDisplay = 0;
      const scores = {};

      // Calcul des scores réels basés sur les probabilités stockées
      CANDIDATES.forEach(id => {
        const val = parseFloat(data[id] || "0");
        scores[id] = Math.floor(val * VOTE_WEIGHT);
        totalDisplay += scores[id];
      });

      const results = {};
      CANDIDATES.forEach(id => {
        results[id] = {
          votes: scores[id],
          percentage: totalDisplay > 0 ? ((scores[id] / totalDisplay) * 100).toFixed(2) : "0.00"
        };
      });

      return Response.json(results, { 
        headers: { ...corsHeaders, "Cache-Control": "public, max-age=30" } 
      });
    }

    // 3. ROUTE : VOTE (Écriture dans le JSON)
    if (url.pathname === "/vote" && request.method === "POST") {
      const cookieHeader = request.headers.get("Cookie") || "";
      const hasVoted = await verifySignature(cookieHeader, COOKIE_SECRET);
      
      if (hasVoted) {
        return new Response("Already voted", { status: 403, headers: corsHeaders });
      }

      const { candidateId, token } = await request.json();

      // Sécurité Turnstile
      const turnstile = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `secret=${env.TURNSTILE_SECRET}&response=${token}`
      });
      if (!(await turnstile.json()).success) {
        return new Response("Security check failed", { status: 403, headers: corsHeaders });
      }

      // Moteur de probabilité
      if (Math.random() < WRITE_PROBABILITY) {
        let data = await env.HOC_VOTES.get("VOTES_DATA", "json") || {};
        data[candidateId] = (parseFloat(data[candidateId]) || 0) + 1;
        await env.HOC_VOTES.put("VOTES_DATA", JSON.stringify(data));
      }

      // Réponse avec Cookie HMAC (Bloque jusqu'à minuit Haïti)
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

// --- FONCTIONS UTILES ---

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
  return new Date(midnight.getTime() + (now.getTimezoneOffset() * 60000));
}
