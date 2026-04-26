// ============================================================
// HOC FANDOM - Cloudflare Worker (Version Optimisée Millions)
// Protection : Turnstile (serveur) + Cookie signé HMAC (minuit Haïti)
// Moteur : Probabilité d'écriture KV + multiplicateur de votes
// Cache : Cloudflare Cache 30s → ~2,880 lectures KV/jour max !
// ============================================================

export default {
  async fetch(request, env) {

    // ⚙️ CONFIG
    const WRITE_PROBABILITY = parseFloat(env.PROBABILITY || "0.001");
    const VOTE_WEIGHT       = parseInt(env.WEIGHT || "1000");
    const COOKIE_SECRET     = env.COOKIE_SECRET || "hoc2027-change-moi-svp";
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

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ============================================================
    // GET /results — Cache 30s + lectures KV parallèles
    // ============================================================
    if (url.pathname === "/results") {

      // Cache Cloudflare 30 secondes
      // 1M visiteurs = seulement ~2,880 lectures KV/jour !
      const cacheKey = new Request("https://cache.hoc-fandom/results");
      const cache = caches.default;
      const cachedResponse = await cache.match(cacheKey);

      if (cachedResponse) {
        const body = await cachedResponse.text();
        return new Response(body, {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "public, max-age=30",
          }
        });
      }

      // Cache manqué → lire KV en parallèle (10x plus rapide)
      const now = Date.now();
      const values = await Promise.all(
        CANDIDATES.map(id => env.HOC_VOTES.get(id))
      );

      let totalDisplay = 0;
      const results = {};

      CANDIDATES.forEach((id, i) => {
        const val = values[i] || "0";
        const baseScore = parseFloat(val) * VOTE_WEIGHT;
        const timeFactor = Math.floor((now % 60000) / 60);
        const candidateOffset = id.length * 13;
        results[id] = Math.floor(baseScore + ((timeFactor + candidateOffset) % 1000));
        totalDisplay += results[id];
      });

      const output = {};
      for (const id of CANDIDATES) {
        output[id] = {
          votes: results[id],
          percentage: totalDisplay > 0
            ? ((results[id] / totalDisplay) * 100).toFixed(2)
            : "0.00"
        };
      }

      const jsonBody = JSON.stringify(output);

      // Stocker dans le cache 30 secondes
      await cache.put(cacheKey, new Response(jsonBody, {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=30"
        }
      }));

      return new Response(jsonBody, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=30",
        }
      });
    }

    // ============================================================
    // POST /vote — Enregistre un vote
    // ============================================================
    if (url.pathname === "/vote" && request.method === "POST") {
      try {
        const body = await request.json();
        const { candidateId, token } = body;
        const ip = request.headers.get("cf-connecting-ip") || "unknown";

        // 1. Validation basique
        if (!CANDIDATES.includes(candidateId) || !token) {
          return jsonResponse({ error: "Données manquantes" }, 400, corsHeaders);
        }

        // 2. Vérification Turnstile côté serveur
        const formData = new FormData();
        formData.append("secret", env.TURNSTILE_SECRET);
        formData.append("response", token);
        formData.append("remoteip", ip);

        const tsRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          body: formData
        });
        const outcome = await tsRes.json();

        if (!outcome.success) {
          return jsonResponse({ error: "Vérification humaine échouée" }, 403, corsHeaders);
        }

        // 3. Vérification cookie signé (1 vote par jour par navigateur)
        const cookieHeader = request.headers.get("Cookie") || "";
        const voteCookie   = parseCookie(cookieHeader, "hoc_voted");

        if (voteCookie) {
          const isValid = await verifyCookieSignature(voteCookie, COOKIE_SECRET);
          if (isValid) {
            return jsonResponse({ error: "Ou deja vote pou jodi a!" }, 429, corsHeaders);
          }
        }

        // 4. Moteur de probabilité — écriture KV rare
        if (Math.random() < WRITE_PROBABILITY) {
          const cur = await env.HOC_VOTES.get(candidateId) || "0";
          await env.HOC_VOTES.put(candidateId, (parseFloat(cur) + 1).toString());
        }

        // 5. Cookie signé (expire à minuit heure Haïti)
        const signedCookie = await createSignedCookie(COOKIE_SECRET);
        const midnight     = getHaitiMidnight();

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            "Set-Cookie": `hoc_voted=${signedCookie}; Path=/; HttpOnly; Secure; SameSite=None; Expires=${midnight}`
          }
        });

      } catch (e) {
        return jsonResponse({ error: "Erreur serveur" }, 500, corsHeaders);
      }
    }

    return new Response("HOC FANDOM Engine Online", { status: 200 });
  }
};

// ============================================================
// UTILITAIRES
// ============================================================

async function createSignedCookie(secret) {
  const today   = new Date().toISOString().split("T")[0];
  const payload = `voted_${today}`;
  const sig     = await hmacSign(payload, secret);
  return `${payload}.${sig}`;
}

async function verifyCookieSignature(cookieValue, secret) {
  try {
    const dotIndex = cookieValue.lastIndexOf(".");
    if (dotIndex === -1) return false;
    const payload = cookieValue.substring(0, dotIndex);
    const sig     = cookieValue.substring(dotIndex + 1);
    const today   = new Date().toISOString().split("T")[0];
    if (!payload.includes(today)) return false;
    const expectedSig = await hmacSign(payload, secret);
    return expectedSig === sig;
  } catch {
    return false;
  }
}

async function hmacSign(message, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function parseCookie(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function getHaitiMidnight() {
  const now      = new Date();
  const haiti    = new Date(now.toLocaleString("en-US", { timeZone: "America/Port-au-Prince" }));
  const midnight = new Date(haiti);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 0, 0);
  const offset = 5 * 60 * 60 * 1000;
  return new Date(midnight.getTime() + offset).toUTCString();
}

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
                      }
