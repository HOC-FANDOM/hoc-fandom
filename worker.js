// ============================================================
// HOC FANDOM - Cloudflare Worker (Version Finale Fusionnée)
// Protection : Turnstile (serveur) + Cookie signé HMAC (minuit Haïti)
// Moteur : Probabilité d'écriture KV + multiplicateur de votes
// ============================================================

export default {
  async fetch(request, env) {

    // ⚙️ CONFIG — modifiable via Variables d'environnement Cloudflare
    const WRITE_PROBABILITY = parseFloat(env.PROBABILITY || "0.001"); // 1/1000 écritures réelles
    const VOTE_WEIGHT       = parseInt(env.WEIGHT || "1000");          // 1 écriture = 1000 votes affichés
    const COOKIE_SECRET     = env.COOKIE_SECRET || "hoc2027-change-moi-svp"; // ⚠️ Mettre dans les secrets Cloudflare
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

    // Preflight CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ============================================================
    // GET /results — Retourne les votes affichés + pourcentages
    // ============================================================
    if (url.pathname === "/results") {
      const now = Date.now();
      let results = {};
      let totalDisplay = 0;

      // Lire tous les scores
      for (const id of CANDIDATES) {
        const val = await env.HOC_VOTES.get(id) || "0";
        const baseScore = parseFloat(val) * VOTE_WEIGHT;
        const timeFactor = Math.floor((now % 60000) / 60);
        const candidateOffset = id.length * 13;
        results[id] = Math.floor(baseScore + ((timeFactor + candidateOffset) % 1000));
        totalDisplay += results[id];
      }

      // Ajouter les pourcentages
      const output = {};
      for (const id of CANDIDATES) {
        output[id] = {
          votes: results[id],
          percentage: totalDisplay > 0
            ? ((results[id] / totalDisplay) * 100).toFixed(2)
            : "0.00"
        };
      }

      return new Response(JSON.stringify(output), {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Cache-Control": "no-store"
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

        const tsRes  = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
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

        // 5. Créer le cookie signé (expire à minuit heure Haïti)
        const signedCookie = await createSignedCookie(COOKIE_SECRET);
        const midnight     = getHaitiMidnight();

        const responseHeaders = {
          ...corsHeaders,
          "Content-Type": "application/json",
          "Set-Cookie": `hoc_voted=${signedCookie}; Path=/; HttpOnly; Secure; SameSite=None; Expires=${midnight}`
        };

        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: responseHeaders
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

// Cookie signé : payload = "voted_2026-04-25" + signature HMAC
async function createSignedCookie(secret) {
  const today   = new Date().toISOString().split("T")[0];
  const payload = `voted_${today}`;
  const sig     = await hmacSign(payload, secret);
  return `${payload}.${sig}`;
}

// Vérifie que le cookie est valide ET date d'aujourd'hui
async function verifyCookieSignature(cookieValue, secret) {
  try {
    const dotIndex = cookieValue.lastIndexOf(".");
    if (dotIndex === -1) return false;

    const payload = cookieValue.substring(0, dotIndex);
    const sig     = cookieValue.substring(dotIndex + 1);

    // Vérifier que c'est le bon jour
    const today = new Date().toISOString().split("T")[0];
    if (!payload.includes(today)) return false; // Ancien cookie = expiré

    const expectedSig = await hmacSign(payload, secret);
    return expectedSig === sig;
  } catch {
    return false;
  }
}

// Signature HMAC-SHA256 en base64url
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

// Parser un cookie par nom
function parseCookie(cookieHeader, name) {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// Minuit heure Haïti (UTC-5) pour l'expiration du cookie
function getHaitiMidnight() {
  const now   = new Date();
  const haiti = new Date(now.toLocaleString("en-US", { timeZone: "America/Port-au-Prince" }));
  const midnight = new Date(haiti);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 0, 0);
  const offset = 5 * 60 * 60 * 1000; // UTC-5
  return new Date(midnight.getTime() + offset).toUTCString();
}

function jsonResponse(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}
