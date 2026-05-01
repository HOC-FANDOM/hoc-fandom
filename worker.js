// ============================================================
// HOC FANDOM - WORKER V5 (Complet, Plan Free <500 écritures KV/j)
// Stratégie : échantillonnage des votes + cache + rate‑limiter en mémoire
// ============================================================

export default {
  async fetch(request, env) {
    const CONFIG = {
      PROBABILITY: parseFloat(env.PROBABILITY || "0.001"),
      WEIGHT: parseInt(env.WEIGHT || "1000"),
      COOKIE_SECRET: env.COOKIE_SECRET || "hoc2027-secret",
      ORIGIN: "https://houseofchallengefandom.pages.dev",
      CACHE_TTL: 60,
      CANDIDATES: ["Abigail","chrisTell","mcdk","meetch","Leila","jalia","manie","natha","layouyou","abee"],
      VOTE_COOLDOWN_MS: 3000
    };

    const corsHeaders = {
      "Access-Control-Allow-Origin": CONFIG.ORIGIN,
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
        const { candidateId, token } = body;
        if (!CONFIG.CANDIDATES.includes(candidateId) || !token) {
          return respond({ error: "Invalid data" }, 400, corsHeaders);
        }

        // Turnstile
        const turnstileRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          body: `secret=${env.TURNSTILE_SECRET}&response=${token}`
        });
        const turnstileData = await turnstileRes.json();
        if (!turnstileData.success) {
          return respond({ error: "Turnstile failed" }, 403, corsHeaders);
        }

        // Fingerprint
        const fingerprint = await getFingerprint(request);

        // Rate limit en mémoire
        if (!inMemoryRateLimiter(fingerprint, CONFIG.VOTE_COOLDOWN_MS)) {
          return respond({ error: "Too many requests. Please wait a few seconds." }, 429, corsHeaders);
        }

        // Cookie check
        const cookieHeader = request.headers.get("Cookie") || "";
        const voteCookie = extractCookie(cookieHeader, "hoc_voted");
        if (voteCookie) {
          const cookieValid = await verifyCookieForFingerprint(voteCookie, fingerprint, CONFIG.COOKIE_SECRET);
          if (cookieValid) {
            return respond({ error: "You already voted today." }, 429, corsHeaders);
          }
        }

        // Échantillonnage du vote
        if (Math.random() < CONFIG.PROBABILITY) {
          const current = parseFloat(await env.HOC_VOTES.get(candidateId) || "0");
          await env.HOC_VOTES.put(candidateId, (current + 1).toString());
        }

        // Cookie signé
        const expiration = getMidnightHaiti();
        const payload = `voted:${fingerprint}:${expiration.getTime()}`;
        const signature = await sign(payload, CONFIG.COOKIE_SECRET);
        const cookieValue = `${payload}.${signature}`;

        const responseHeaders = new Headers(corsHeaders);
        responseHeaders.append(
          "Set-Cookie",
          `hoc_voted=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=None; Expires=${expiration.toUTCString()}`
        );

        return respond({ success: true }, 200, responseHeaders);
      } catch (e) {
        return respond({ error: "Server error" }, 500, corsHeaders);
      }
    }

    return new Response("HOC FANDOM Worker Online", { status: 200 });
  }
};

// ════════════════════════════════════════════════════════════════
// RATE LIMITER EN MÉMOIRE (partagé entre requêtes du même isolat)
// ════════════════════════════════════════════════════════════════
const lastVoteTimestamps = new Map();

function inMemoryRateLimiter(fingerprint, cooldownMs) {
  const now = Date.now();
  const last = lastVoteTimestamps.get(fingerprint);
  if (last && (now - last) < cooldownMs) {
    return false; // trop tôt
  }
  lastVoteTimestamps.set(fingerprint, now);
  return true;
}

// ════════════════════════════════════════════════════════════════
// FINGERPRINT (IP + User‑Agent)
// ════════════════════════════════════════════════════════════════
async function getFingerprint(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ua = request.headers.get("User-Agent") || "";
  const raw = `${ip}|${ua}`;
  const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ════════════════════════════════════════════════════════════════
// VÉRIFICATION COOKIE LIÉ AU FINGERPRINT
// ════════════════════════════════════════════════════════════════
async function verifyCookieForFingerprint(cookieValue, currentFingerprint, secret) {
  try {
    const [payload, sig] = cookieValue.split('.');
    if (!payload || !sig) return false;
    const expectedSig = await sign(payload, secret);
    if (expectedSig !== sig) return false;

    const parts = payload.split(':');
    if (parts.length < 3 || parts[0] !== 'voted') return false;
    const cookieFingerprint = parts[1];
    if (cookieFingerprint !== currentFingerprint) return false;

    // ✅ AJOUT : vérifier si la date d’expiration est dépassée
    const expirationTime = parseInt(parts[2]);
    if (Date.now() >= expirationTime) return false; // cookie expiré → autoriser un nouveau vote

    return true;
  } catch {
    return false;
  }
}

// ════════════════════════════════════════════════════════════════
// HMAC SIGNATURE
// ════════════════════════════════════════════════════════════════
async function sign(message, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/[+/=]/g, c => c === '+' ? '-' : c === '/' ? '_' : '');
}

// ════════════════════════════════════════════════════════════════
// EXTRACTION COOKIE
// ════════════════════════════════════════════════════════════════
function extractCookie(header, name) {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// ════════════════════════════════════════════════════════════════
// MINUIT HAÏTI (EST)
// ════════════════════════════════════════════════════════════════
function getMidnightHaiti() {
  const now = new Date();
  const haiti = new Date(now.toLocaleString("en-US", { timeZone: "America/Port-au-Prince" }));
  const midnight = new Date(haiti);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 0, 0);
  return new Date(midnight.getTime() + 5 * 60 * 60 * 1000); // UTC-5
}

// ════════════════════════════════════════════════════════════════
// RÉPONSE JSON
// ════════════════════════════════════════════════════════════════
function respond(data, status, corsHeaders, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extraHeaders }
  });
}
