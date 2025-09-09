// app.mjs
import express from "express";
import dotenv from "dotenv";
import { TwitterApi } from "twitter-api-v2";
import cookieParser from "cookie-parser";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import crypto from "crypto";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const REDIRECT_URI = `http://${HOST}:${PORT}/callback`;

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET || "";

app.use(express.json());
app.use(cookieParser());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { sameSite: "lax", maxAge: 7 * 24 * 3600 * 1000 },
  })
);

app.use(express.static(path.join(__dirname, "public")));
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// In-memory demo stores
const USERS = new Map(); // userId -> { user, tokens, eligible }
const CLAIMS = new Map(); // userId -> { when }
const INVITES = new Map(); // userId -> { kol: [{code, used, limit, expiresAt}], normal: {code, used, limit, expiresAt} }

/* ---------- Helpers ---------- */
function mkCode(prefix = "") {
  return prefix + crypto.randomBytes(4).toString("hex");
}
function nowPlusDays(days) {
  return Date.now() + days * 24 * 60 * 60 * 1000;
}
function isExpired(ts) {
  return Date.now() > ts;
}
function ensureInvitesForUser(uid) {
  if (!INVITES.has(uid)) {
    const kolCodes = [];
    for (let i = 0; i < 3; i++) {
      kolCodes.push({
        code: mkCode("KOL-"),
        used: 0,
        limit: 1,
        expiresAt: nowPlusDays(7),
      });
    }
    const normal = {
      code: mkCode("NORM-"),
      used: 0,
      limit: 100,
      expiresAt: nowPlusDays(7),
    };
    INVITES.set(uid, { kol: kolCodes, normal });
  }
  return INVITES.get(uid);
}

/* ---------- Routes: landing, health ---------- */
app.get("/ping", (req, res) => res.send("pong"));

app.get("/", (req, res) => {
  const pubIndex = path.join(__dirname, "public", "index.html");
  const rootIndex = path.join(__dirname, "index.html");
  if (fs.existsSync(pubIndex)) return res.sendFile(pubIndex);
  if (fs.existsSync(rootIndex)) return res.sendFile(rootIndex);
  return res.status(404).send("index.html not found");
});

/* ---------- OAuth start & callback ---------- */
app.get("/login", async (req, res) => {
  try {
    if (!CLIENT_ID) return res.status(500).send("Missing CLIENT_ID in .env");
    const client = new TwitterApi({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const scopes = ["tweet.read", "users.read", "offline.access"];
    const { url, codeVerifier, state } = client.generateOAuth2AuthLink(REDIRECT_URI, { scope: scopes });
    req.session.oauth = { codeVerifier, state };
    await new Promise((r) => req.session.save(r));
    return res.redirect(url);
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).send("Login error: " + (err?.message || err));
  }
});

app.get("/callback", async (req, res) => {
  try {
    const { state, code } = req.query;
    if (!state || !code) return res.status(400).send("Missing state or code");

    const sess = req.session?.oauth;
    if (!sess || sess.state !== state) return res.status(400).send("Invalid or expired state");

    const client = new TwitterApi({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    const { client: loggedClient, accessToken, refreshToken, expiresIn } = await client.loginWithOAuth2({
      code: String(code),
      codeVerifier: sess.codeVerifier,
      redirectUri: REDIRECT_URI,
    });

    const userResp = await loggedClient.v2.me({ "user.fields": "profile_image_url,public_metrics,created_at,verified" });
    const user = userResp.data;
    if (!user) throw new Error("Empty user returned from Twitter");

    // eligibility: >= 1 month (approx 30 days) AND followers > 5000
    const followers = user.public_metrics?.followers_count ?? 0;
    const createdAt = user.created_at ? new Date(user.created_at) : new Date();
    const msSince = Date.now() - createdAt.getTime();
    const monthsSince = msSince / (1000 * 60 * 60 * 24 * 30);
    const eligible = monthsSince >= 1 && followers > 100;

    USERS.set(user.id, {
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        profile_image_url: user.profile_image_url,
        followers,
        createdAt: createdAt.toISOString(),
        verified: user.verified ?? false,
      },
      tokens: { accessToken, refreshToken, expiresIn },
      eligible,
    });

    // ensure invites for user exists (but not regenerate)
    ensureInvitesForUser(user.id);

    res.cookie("uid", user.id, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 });
    delete req.session.oauth;
    return res.redirect("/");
  } catch (err) {
    console.error("Callback error:", err);
    return res.status(500).send("Callback error: " + (err?.message || err));
  }
});

/* ---------- API: /api/me, /api/claim ---------- */
app.get("/api/me", (req, res) => {
  try {
    const uid = req.cookies?.uid;
    if (!uid) return res.status(401).json({ error: "Not connected" });
    const stored = USERS.get(uid);
    if (!stored) return res.status(401).json({ error: "No stored user" });

    // ensure invites exist
    const invites = ensureInvitesForUser(uid);
    const inviterView = {
      kol: invites.kol.map((c) => ({
        code: c.code,
        used: c.used,
        limit: c.limit,
        expiresAt: c.expiresAt,
        valid: !isExpired(c.expiresAt) && c.used < c.limit,
      })),
      normal: {
        code: invites.normal.code,
        used: invites.normal.used,
        limit: invites.normal.limit,
        expiresAt: invites.normal.expiresAt,
        valid: !isExpired(invites.normal.expiresAt) && invites.normal.used < invites.normal.limit,
        remaining: Math.max(0, invites.normal.limit - invites.normal.used),
      },
    };

    const claimed = CLAIMS.has(uid) ? { when: CLAIMS.get(uid).when } : null;

    return res.json({
      user: stored.user,
      eligible: stored.eligible,
      claimed,
      invites: inviterView,
    });
  } catch (err) {
    console.error("/api/me error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/claim", (req, res) => {
  try {
    const uid = req.cookies?.uid;
    if (!uid) return res.status(401).json({ error: "Not connected" });
    const stored = USERS.get(uid);
    if (!stored) return res.status(401).json({ error: "No stored user" });

    if (!stored.eligible) {
      return res.status(403).json({ error: "User not eligible" });
    }
    if (CLAIMS.has(uid)) {
      return res.status(409).json({ error: "Already claimed" });
    }

    const when = new Date().toISOString();
    CLAIMS.set(uid, { when });

    // create invites upon claim (fresh reset of 7 days)
    INVITES.set(uid, {
      kol: Array.from({ length: 3 }).map(() => ({
        code: mkCode("KOL-"),
        used: 0,
        limit: 1,
        expiresAt: nowPlusDays(7),
      })),
      normal: {
        code: mkCode("NORM-"),
        used: 0,
        limit: 100,
        expiresAt: nowPlusDays(7),
      },
    });

    console.log(`User ${uid} claimed demo at ${when} — invites created.`);

    return res.json({
      success: true,
      when,
      card: {
        id: `demo-card-${uid}`,
        title: "Demo Reward Card",
        message: `Congrats! You claimed a demo reward.`,
      },
    });
  } catch (err) {
    console.error("/api/claim error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ---------- INVITES API ---------- */
app.get("/api/invites", (req, res) => {
  try {
    const uid = req.cookies?.uid;
    if (!uid) return res.status(401).json({ error: "Not connected" });
    const invites = ensureInvitesForUser(uid);
    const view = {
      kol: invites.kol.map((c) => ({
        code: c.code,
        used: c.used,
        limit: c.limit,
        expiresAt: c.expiresAt,
        valid: !isExpired(c.expiresAt) && c.used < c.limit,
      })),
      normal: {
        code: invites.normal.code,
        used: invites.normal.used,
        limit: invites.normal.limit,
        expiresAt: invites.normal.expiresAt,
        valid: !isExpired(invites.normal.expiresAt) && invites.normal.used < invites.normal.limit,
        remaining: Math.max(0, invites.normal.limit - invites.normal.used),
      },
    };
    return res.json(view);
  } catch (err) {
    console.error("/api/invites error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/invites/:type/regenerate", (req, res) => {
  try {
    const uid = req.cookies?.uid;
    if (!uid) return res.status(401).json({ error: "Not connected" });
    const type = req.params.type;
    const invites = ensureInvitesForUser(uid);

    if (type === "kol") {
      invites.kol = Array.from({ length: 3 }).map(() => ({
        code: mkCode("KOL-"),
        used: 0,
        limit: 1,
        expiresAt: nowPlusDays(7),
      }));
    } else if (type === "normal") {
      invites.normal = { code: mkCode("NORM-"), used: 0, limit: 100, expiresAt: nowPlusDays(7) };
    } else {
      return res.status(400).json({ error: "Unknown invite type" });
    }

    INVITES.set(uid, invites);
    console.log(`Invites regenerated for ${uid} type=${type}`);
    return res.json({ ok: true, invites: invites[type] });
  } catch (err) {
    console.error("/api/invites/regenerate error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/invites/use", (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "code required" });

    for (const [ownerId, invites] of INVITES.entries()) {
      for (const c of invites.kol) {
        if (c.code === code) {
          if (isExpired(c.expiresAt)) return res.status(410).json({ error: "Invite expired" });
          if (c.used >= c.limit) return res.status(409).json({ error: "Invite already used" });
          c.used += 1;
          console.log(`Invite code ${code} used for owner ${ownerId} (kol).`);
          return res.json({ ok: true, owner: ownerId, type: "kol" });
        }
      }
      if (invites.normal.code === code) {
        const n = invites.normal;
        if (isExpired(n.expiresAt)) return res.status(410).json({ error: "Invite expired" });
        if (n.used >= n.limit) return res.status(409).json({ error: "Invite exhausted" });
        n.used += 1;
        console.log(`Invite code ${code} used for owner ${ownerId} (normal). remaining=${n.limit - n.used}`);
        return res.json({ ok: true, owner: ownerId, type: "normal", remaining: Math.max(0, n.limit - n.used) });
      }
    }

    return res.status(404).json({ error: "Invite code not found" });
  } catch (err) {
    console.error("/api/invites/use error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ---------- logout ---------- */
app.post("/api/logout", (req, res) => {
  try {
    const uid = req.cookies?.uid;
    if (uid) res.clearCookie("uid");
    return res.json({ ok: true });
  } catch (err) {
    console.error("/api/logout error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

/* ---------- errors & start ---------- */
process.on("uncaughtException", (err) => console.error("Uncaught Exception:", err));
process.on("unhandledRejection", (err) => console.error("Unhandled Rejection:", err));

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Make sure your Twitter app Redirect URI is set to: http://${HOST}:${PORT}/callback`);
});
