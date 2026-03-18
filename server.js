require("dotenv").config();
const express = require("express");
const path = require("path");
const { TeamSpeak } = require("ts3-nodejs-library");
const http = require("http");
const https = require("https");

const app = express();
const session = require("express-session");

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Session for Discord OAuth2
app.use(session({
  secret: process.env.SESSION_SECRET || require("crypto").randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 2, // 2 hours
    httpOnly: true,
    sameSite: "lax",
  },
}));

// Trust proxy if behind nginx/reverse proxy in Docker
if (process.env.TRUST_PROXY === "true") {
  app.set("trust proxy", true);
}

// ─────────────────────────────────────────────
//  LOAD LOCALE
// ─────────────────────────────────────────────
const fs = require("fs");
const LANG = (process.env.LANGUAGE || "pl").toLowerCase();
const localePath = path.join(__dirname, "locales", `${LANG}.json`);

let t = {};
try {
  t = JSON.parse(fs.readFileSync(localePath, "utf8"));
  console.log(`[i18n] Loaded locale: ${LANG}`);
} catch (e) {
  console.error(`[i18n] Failed to load locale "${LANG}", falling back to pl`);
  try {
    t = JSON.parse(fs.readFileSync(path.join(__dirname, "locales", "pl.json"), "utf8"));
  } catch {
    console.error("[i18n] FATAL: Cannot load any locale file!");
    t = {};
  }
}

// Helper: replace {key} placeholders in translation strings
function tr(key, replacements = {}) {
  let str = t[key] || key;
  for (const [k, v] of Object.entries(replacements)) {
    str = str.replace(`{${k}}`, v);
  }
  return str;
}

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const CONFIG = {
  ts3: {
    host: process.env.TS3_HOST || "127.0.0.1",
    queryPort: parseInt(process.env.TS3_QUERY_PORT) || 10011,
    username: process.env.TS3_USERNAME || "serveradmin",
    password: process.env.TS3_PASSWORD || "",
    serverId: parseInt(process.env.TS3_SERVER_ID) || 1,
  },
  ts6: {
    host: process.env.TS6_HOST || "127.0.0.1",
    queryPort: parseInt(process.env.TS6_QUERY_PORT) || 10080,
    sshPort: parseInt(process.env.TS6_SSH_PORT) || 10022,
    username: process.env.TS6_USERNAME || "serveradmin",
    password: process.env.TS6_PASSWORD || "",
    apiKey: process.env.TS6_API_KEY || "",
    serverId: parseInt(process.env.TS6_SERVER_ID) || 1,
  },
  web: {
    port: parseInt(process.env.WEB_PORT) || 5540,
    logoUrl: process.env.LOGO_URL || "",
    ts3ConnectAddress: process.env.TS3_CONNECT_ADDRESS || "",
    ts6ConnectAddress: process.env.TS6_CONNECT_ADDRESS || "",
  },
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || "",
    clientSecret: process.env.DISCORD_CLIENT_SECRET || "",
    botToken: process.env.DISCORD_BOT_TOKEN || "",
    guildId: process.env.DISCORD_GUILD_ID || "",
    redirectUri: process.env.DISCORD_REDIRECT_URI || "",
    // Format: "dc_role_id:ts_group_id,dc_role_id:ts_group_id"
    roleMapping: (process.env.DISCORD_ROLE_MAPPING || "")
      .split(",")
      .filter(Boolean)
      .reduce((map, pair) => {
        const [dcRole, tsGroup] = pair.split(":").map(s => s.trim());
        if (dcRole && tsGroup) map[dcRole] = tsGroup;
        return map;
      }, {}),
  },
};

// ─────────────────────────────────────────────
//  HELPER: Get real client IP
// ─────────────────────────────────────────────
function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  const ip = req.ip || req.connection.remoteAddress || "";
  // Normalize IPv6-mapped IPv4
  return ip.replace(/^::ffff:/, "");
}

// ─────────────────────────────────────────────
//  TS3 MODULE (ts3-nodejs-library)
// ─────────────────────────────────────────────
class TS3Service {
  async connect() {
    this.client = await TeamSpeak.connect({
      host: CONFIG.ts3.host,
      queryport: CONFIG.ts3.queryPort,
      serverport: 9987, // default voice port
      username: CONFIG.ts3.username,
      password: CONFIG.ts3.password,
      nickname: "RankTransferBot",
    });
    await this.client.useBySid(String(CONFIG.ts3.serverId));
    console.log("[TS3] Connected to TeamSpeak 3 server");
    return this.client;
  }

  async disconnect() {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }

  /**
   * Find all clients connected from a given IP.
   * Returns array of { clid, nickname, dbid, ip, serverGroups }
   */
  async findClientsByIp(ip) {
    const client = await this.connect();
    try {
      // Use raw command with -ip flag to get IPs directly in clientlist
      // ts3-nodejs-library clientList doesn't always pass -ip flag properly
      const rawClients = await client.execute("clientlist", ["-ip", "-groups"]);
      const clientArray = Array.isArray(rawClients) ? rawClients : [rawClients];

      // Filter out query clients (type 1)
      const normalClients = clientArray.filter(cl => String(cl.clientType || cl.client_type || 0) === "0");
      console.log(`[TS3] Found ${normalClients.length} normal clients online (raw: ${clientArray.length})`);

      const matches = [];
      for (const cl of normalClients) {
        // Log all properties of first client for debugging
        if (normalClients.indexOf(cl) === 0) {
          console.log(`[TS3] Sample client properties: ${JSON.stringify(Object.keys(cl))}`);
        }

        // Try every possible IP property name
        const clientIp =
          cl.connectionClientIp ||
          cl.connection_client_ip ||
          cl.clientIp ||
          cl.client_ip ||
          cl.ip ||
          "";

        const nickname =
          cl.clientNickname ||
          cl.client_nickname ||
          cl.nickname ||
          "Unknown";

        console.log(`[TS3]   - ${nickname} | IP: ${clientIp} | searching: ${ip} | match: ${clientIp === ip}`);

        if (clientIp === ip) {
          const groups =
            cl.clientServergroups ||
            cl.client_servergroups ||
            cl.servergroups ||
            cl.serverGroups ||
            "";

          const dbid =
            cl.clientDatabaseId ||
            cl.client_database_id ||
            cl.cldbid ||
            cl.databaseId ||
            "";

          const uniqueId =
            cl.clientUniqueIdentifier ||
            cl.client_unique_identifier ||
            cl.uniqueIdentifier ||
            "";

          const groupsArray = Array.isArray(groups)
            ? groups.map(String)
            : String(groups).split(",").filter(Boolean);

          console.log(`[TS3]   → Matched! Groups: ${JSON.stringify(groupsArray)}, DBID: ${dbid}`);

          matches.push({
            clid: cl.clid,
            nickname,
            dbid,
            uniqueId,
            ip: clientIp,
            serverGroups: groupsArray,
          });
        }
      }
      return matches;
    } finally {
      await this.disconnect();
    }
  }

  /**
   * Fetch all server groups and return a map of { id: name }
   */
  async getServerGroupNames() {
    const client = await this.connect();
    try {
      const groups = await client.serverGroupList();
      const map = {};
      for (const g of groups) {
        map[String(g.sgid)] = g.name;
      }
      console.log(`[TS3] Loaded ${Object.keys(map).length} server groups`);
      return map;
    } finally {
      await this.disconnect();
    }
  }
}

// ─────────────────────────────────────────────
//  TS6 MODULE (HTTP ServerQuery API)
// ─────────────────────────────────────────────
//
//  TeamSpeak 6 / newer TS servers expose an HTTP
//  query interface on port 10080. If your TS6 uses
//  a different API (REST, gRPC, etc.), adjust the
//  methods below accordingly.
//
//  The HTTP ServerQuery uses the same commands as
//  the classic telnet query, but over HTTP with
//  JSON responses.
// ─────────────────────────────────────────────
class TS6Service {
  constructor() {
    this.baseUrl = `http://${CONFIG.ts6.host}:${CONFIG.ts6.queryPort}`;
    this.apiKey = CONFIG.ts6.apiKey;
    this.serverId = CONFIG.ts6.serverId;
  }

  /**
   * Make an HTTP request to the TS6 ServerQuery HTTP API.
   *
   * TS HTTP query URL format:
   *   http://host:port/{serverID}/{command}?param=value&-flag
   *
   * Auth via x-api-key header or Basic auth.
   *
   * @param {string} command - e.g. "clientlist", "servergroupaddclient"
   * @param {object} params  - key-value params (keys starting with "-" are flags)
   */
  async query(command, params = {}, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this._doQuery(command, params);
      } catch (e) {
        const isRetryable = e.message.includes("ECONNRESET") ||
          e.message.includes("ECONNREFUSED") ||
          e.message.includes("timeout") ||
          e.message.includes("socket hang up");
        if (isRetryable && attempt < retries) {
          const delay = attempt * 1500;
          console.log(`[TS6] Query failed (${e.message}), retrying in ${delay}ms... (${attempt}/${retries})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw e;
      }
    }
  }

  async _doQuery(command, params = {}) {
    // Build URL with server ID in path: /{sid}/{command}
    const url = new URL(`/${this.serverId}/${command}`, this.baseUrl);

    for (const [key, val] of Object.entries(params)) {
      if (val !== undefined && val !== null) {
        // Flags like "-ip", "-groups" are appended without value
        if (key.startsWith("-") && val === "") {
          url.searchParams.set(key, "");
        } else {
          url.searchParams.set(key, String(val));
        }
      }
    }

    const headers = {
      "Content-Type": "application/json",
    };

    // Prefer API key auth, fall back to Basic auth
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    } else {
      const creds = Buffer.from(
        `${CONFIG.ts6.username}:${CONFIG.ts6.password}`
      ).toString("base64");
      headers["Authorization"] = `Basic ${creds}`;
    }

    // Clean up URL: remove "=" for empty flag params (e.g. "-ip=" → "-ip")
    let urlStr = url.toString().replace(/(-\w+)=(&|$)/g, "$1$2");

    console.log(`[TS6] Query: ${urlStr}`);

    return new Promise((resolve, reject) => {
      const req = http.request(
        urlStr,
        { method: "GET", headers, timeout: 10000 },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            console.log(`[TS6] Response (${res.statusCode}): ${data.slice(0, 500)}`);
            try {
              const json = JSON.parse(data);
              if (json.status && json.status.code !== 0) {
                reject(
                  new Error(
                    `TS6 query error: ${json.status.message} (code ${json.status.code})`
                  )
                );
              } else {
                resolve(json.body || json);
              }
            } catch {
              reject(new Error(`TS6 invalid response: ${data.slice(0, 200)}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("TS6 query timeout"));
      });
      req.end();
    });
  }

  /**
   * Find all clients connected from a given IP.
   */
  async findClientsByIp(ip) {
    const clients = await this.query("clientlist", {
      "-ip": "",
      "-groups": "",
    });

    if (!clients || !Array.isArray(clients)) {
      // Try alternative response format
      const arr = clients ? [clients] : [];
      return this._filterByIp(arr, ip);
    }

    return this._filterByIp(clients, ip);
  }

  _filterByIp(clients, ip) {
    console.log(`[TS6] Filtering ${clients.length} clients for IP: ${ip}`);
    return clients
      .filter((cl) => {
        const clientIp =
          cl.connection_client_ip || cl.client_ip || cl.ip || "";
        // client_type can be string "0" or number 0 — use == for loose comparison
        const isNormalClient = cl.client_type == 0 || cl.client_type === undefined;
        console.log(`[TS6]   - ${cl.client_nickname || cl.nickname} | IP: ${clientIp} | type: ${cl.client_type} (${typeof cl.client_type}) | match: ${clientIp === ip && isNormalClient}`);
        return clientIp === ip && isNormalClient;
      })
      .map((cl) => ({
        clid: cl.clid,
        nickname: cl.client_nickname || cl.nickname || "Unknown",
        dbid: cl.client_database_id || cl.cldbid,
        uniqueId: cl.client_unique_identifier || cl.client_unique_id || "",
        ip: cl.connection_client_ip || cl.client_ip || cl.ip,
        serverGroups: this._parseGroups(
          cl.client_servergroups || cl.servergroups || ""
        ),
      }));
  }

  _parseGroups(groups) {
    if (Array.isArray(groups)) return groups.map(Number);
    if (typeof groups === "string" && groups.length > 0) {
      return groups.split(",").map((g) => parseInt(g.trim(), 10)).filter(n => !isNaN(n));
    }
    return [];
  }

  /**
   * Add a server group to a client (by database ID).
   */
  async addServerGroup(dbid, groupId) {
    return this.query("servergroupaddclient", {
      sgid: groupId,
      cldbid: dbid,
    });
  }

  /**
   * Fetch all server groups and return a map of { id: name }
   */
  async getServerGroupNames() {
    try {
      const groups = await this.query("servergrouplist");
      const arr = Array.isArray(groups) ? groups : [groups];
      const map = {};
      for (const g of arr) {
        const id = String(g.sgid);
        const name = g.name || g.servergroup_name || `Group ${id}`;
        map[id] = name;
      }
      console.log(`[TS6] Loaded ${Object.keys(map).length} server groups`);
      return map;
    } catch (e) {
      console.error("[TS6] Failed to load server groups:", e.message);
      return {};
    }
  }
}

// ─────────────────────────────────────────────
//  DISCORD MODULE (OAuth2 + Bot API)
// ─────────────────────────────────────────────
class DiscordService {
  constructor() {
    this.clientId = CONFIG.discord.clientId;
    this.clientSecret = CONFIG.discord.clientSecret;
    this.botToken = CONFIG.discord.botToken;
    this.guildId = CONFIG.discord.guildId;
    this.redirectUri = CONFIG.discord.redirectUri;
    this.roleMapping = CONFIG.discord.roleMapping;

    this.enabled = !!(
      this.clientId &&
      this.clientSecret &&
      this.botToken &&
      this.guildId &&
      this.redirectUri &&
      Object.keys(this.roleMapping).length > 0
    );

    if (this.enabled) {
      console.log(`[Discord] OAuth2 enabled — guild: ${this.guildId}, mappings: ${Object.keys(this.roleMapping).length}`);
    } else {
      console.log("[Discord] Disabled (missing DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_REDIRECT_URI, or DISCORD_ROLE_MAPPING)");
    }
  }

  /** Build the OAuth2 authorize URL */
  getAuthUrl(state) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      scope: "identify",
      state,
    });
    return `https://discord.com/api/oauth2/authorize?${params}`;
  }

  /** Exchange authorization code for access token */
  async exchangeCode(code) {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
    });

    return new Promise((resolve, reject) => {
      const req = https.request("https://discord.com/api/v10/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.access_token) resolve(json);
            else reject(new Error(json.error_description || json.error || "Token exchange failed"));
          } catch { reject(new Error("Invalid token response")); }
        });
      });
      req.on("error", reject);
      req.write(body.toString());
      req.end();
    });
  }

  /** Get user profile using their OAuth2 access token */
  async getUser(accessToken) {
    return this._apiCall("https://discord.com/api/v10/users/@me", `Bearer ${accessToken}`);
  }

  /** Get guild member roles using the BOT token */
  async getMemberRoles(userId) {
    const member = await this._apiCall(
      `https://discord.com/api/v10/guilds/${this.guildId}/members/${userId}`,
      `Bot ${this.botToken}`
    );
    const roles = member.roles || [];

    // Map Discord roles to TS group IDs
    const mappedGroups = [];
    for (const roleId of roles) {
      if (this.roleMapping[roleId]) {
        mappedGroups.push(this.roleMapping[roleId]);
      }
    }

    console.log(`[Discord] User ${userId} roles: [${roles.join(",")}] → TS groups: [${mappedGroups.join(",")}]`);
    return { roles, mappedGroups };
  }

  /** Generic Discord API GET */
  _apiCall(url, auth) {
    return new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: "GET",
        headers: { "Authorization": auth },
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode === 200) resolve(json);
            else reject(new Error(json.message || `Discord API ${res.statusCode}`));
          } catch { reject(new Error(`Discord invalid response`)); }
        });
      });
      req.on("error", reject);
      req.end();
    });
  }
}

// ─────────────────────────────────────────────
//  INSTANCES
// ─────────────────────────────────────────────
const ts3 = new TS3Service();
const ts6 = new TS6Service();
const discord = new DiscordService();

// ─────────────────────────────────────────────
//  RATE LIMITING (simple in-memory)
// ─────────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_MS = 30000; // 30 seconds between transfers

function isRateLimited(ip) {
  const last = rateLimitMap.get(ip);
  if (last && Date.now() - last < RATE_LIMIT_MS) {
    return true;
  }
  return false;
}

function setRateLimit(ip) {
  rateLimitMap.set(ip, Date.now());
}

// ─────────────────────────────────────────────
//  API ROUTES
// ─────────────────────────────────────────────

// GET /api/config - Serve frontend config (logo, language, translations)
app.get("/api/config", (req, res) => {
  res.json({
    logoUrl: CONFIG.web.logoUrl,
    language: LANG,
    ts3ConnectAddress: CONFIG.web.ts3ConnectAddress,
    ts6ConnectAddress: CONFIG.web.ts6ConnectAddress,
    discordEnabled: discord.enabled,
    t,
  });
});

// GET /api/status - Check what the user's IP sees on both servers
app.get("/api/status", async (req, res) => {
  const ip = getClientIp(req);

  try {
    let ts3Clients = [];
    let ts6Clients = [];
    let ts3Error = null;
    let ts6Error = null;
    let ts3Groups = {};
    let ts6Groups = {};

    try {
      ts3Clients = await ts3.findClientsByIp(ip);
      ts3Groups = await ts3.getServerGroupNames();
    } catch (e) {
      ts3Error = e.message;
      console.error("[TS3] Error finding clients:", e.message);
    }

    try {
      ts6Clients = await ts6.findClientsByIp(ip);
      ts6Groups = await ts6.getServerGroupNames();
    } catch (e) {
      ts6Error = e.message;
      console.error("[TS6] Error finding clients:", e.message);
    }

    res.json({
      ip,
      ts3: {
        clients: ts3Clients,
        count: ts3Clients.length,
        error: ts3Error,
        groupNames: ts3Groups,
      },
      ts6: {
        clients: ts6Clients,
        count: ts6Clients.length,
        error: ts6Error,
        groupNames: ts6Groups,
      },
    });
  } catch (e) {
    console.error("[STATUS] Error:", e);
    res.status(500).json({ error: `${tr("err_server")} ${e.message}` });
  }
});

// POST /api/transfer - Transfer ranks from TS3 to TS6
app.post("/api/transfer", async (req, res) => {
  const ip = getClientIp(req);

  // Rate limit check
  if (isRateLimited(ip)) {
    return res.status(429).json({
      success: false,
      error: tr("err_rate_limit"),
    });
  }

  try {
    // ── Step 1: Find TS3 clients by IP ──
    let ts3Clients;
    try {
      ts3Clients = await ts3.findClientsByIp(ip);
    } catch (e) {
      return res.status(503).json({
        success: false,
        error: `${tr("err_ts3_connect")} ${e.message}`,
      });
    }

    if (ts3Clients.length === 0) {
      return res.status(404).json({
        success: false,
        error: tr("err_ts3_not_found"),
      });
    }

    if (ts3Clients.length > 1) {
      return res.status(400).json({
        success: false,
        error: tr("err_ts3_multiple", { count: ts3Clients.length, ip }),
        details: ts3Clients.map((c) => ({
          nickname: c.nickname,
          groups: c.serverGroups,
        })),
      });
    }

    // ── Step 2: Find TS6 clients by IP ──
    let ts6Clients;
    try {
      ts6Clients = await ts6.findClientsByIp(ip);
    } catch (e) {
      return res.status(503).json({
        success: false,
        error: `${tr("err_ts6_connect")} ${e.message}`,
      });
    }

    if (ts6Clients.length === 0) {
      return res.status(404).json({
        success: false,
        error: tr("err_ts6_not_found"),
      });
    }

    if (ts6Clients.length > 1) {
      return res.status(400).json({
        success: false,
        error: tr("err_ts6_multiple", { count: ts6Clients.length, ip }),
        details: ts6Clients.map((c) => ({
          nickname: c.nickname,
          groups: c.serverGroups,
        })),
      });
    }

    // ── Step 3: We have exactly 1 client on each server ──
    const ts3Client = ts3Clients[0];
    const ts6Client = ts6Clients[0];
    const groupsToTransfer = ts3Client.serverGroups.filter(
      (g) => !ts6Client.serverGroups.includes(g)
    );

    if (groupsToTransfer.length === 0) {
      return res.json({
        success: true,
        message: tr("msg_synced"),
        ts3Nickname: ts3Client.nickname,
        ts6Nickname: ts6Client.nickname,
        groups: ts3Client.serverGroups,
        transferred: [],
      });
    }

    // ── Step 4: Assign groups on TS6 ──
    const transferred = [];
    const errors = [];

    for (const groupId of groupsToTransfer) {
      try {
        await ts6.addServerGroup(ts6Client.dbid, groupId);
        transferred.push(groupId);
      } catch (e) {
        errors.push({ groupId, error: e.message });
        console.error(
          `[TRANSFER] Failed to add group ${groupId} to TS6 client ${ts6Client.dbid}:`,
          e.message
        );
      }
    }

    setRateLimit(ip);

    res.json({
      success: true,
      message: errors.length === 0 ? tr("msg_success") : tr("msg_partial"),
      ts3Nickname: ts3Client.nickname,
      ts6Nickname: ts6Client.nickname,
      allGroups: ts3Client.serverGroups,
      transferred,
      alreadyHad: ts3Client.serverGroups.filter((g) =>
        ts6Client.serverGroups.includes(g)
      ),
      errors,
    });
  } catch (e) {
    console.error("[TRANSFER] Unexpected error:", e);
    res.status(500).json({
      success: false,
      error: `${tr("err_server")} ${e.message}`,
    });
  }
});

// ─────────────────────────────────────────────
//  DISCORD OAuth2
// ─────────────────────────────────────────────

// GET /auth/discord - Redirect to Discord login
app.get("/auth/discord", (req, res) => {
  if (!discord.enabled) return res.redirect("/");
  const state = require("crypto").randomBytes(16).toString("hex");
  req.session.oauthState = state;
  res.redirect(discord.getAuthUrl(state));
});

// GET /auth/discord/callback - Handle Discord OAuth2 callback
app.get("/auth/discord/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || state !== req.session.oauthState) {
    return res.redirect("/?discord_error=invalid_state");
  }

  delete req.session.oauthState;

  try {
    // Exchange code for token
    const tokenData = await discord.exchangeCode(code);

    // Get user profile
    const user = await discord.getUser(tokenData.access_token);

    // Get guild member roles via bot
    let memberData = { roles: [], mappedGroups: [] };
    try {
      memberData = await discord.getMemberRoles(user.id);
    } catch (e) {
      console.error("[Discord] Failed to get member roles:", e.message);
    }

    // Save to session
    req.session.discord = {
      id: user.id,
      username: user.global_name || user.username,
      avatar: user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
        : `https://cdn.discordapp.com/embed/avatars/${(BigInt(user.id) >> 22n) % 6n}.png`,
      roles: memberData.roles,
      mappedGroups: memberData.mappedGroups,
    };

    console.log(`[Discord] User logged in: ${req.session.discord.username} (${user.id})`);
    res.redirect("/?tab=discord");
  } catch (e) {
    console.error("[Discord] OAuth2 error:", e.message);
    res.redirect("/?discord_error=" + encodeURIComponent(e.message));
  }
});

// GET /auth/discord/logout
app.get("/auth/discord/logout", (req, res) => {
  delete req.session.discord;
  res.redirect("/?tab=discord");
});

// GET /api/discord/me - Get logged-in Discord user info
app.get("/api/discord/me", (req, res) => {
  if (!req.session.discord) {
    return res.json({ loggedIn: false });
  }
  res.json({
    loggedIn: true,
    ...req.session.discord,
  });
});

// POST /api/discord/transfer - Transfer Discord roles to TS6
app.post("/api/discord/transfer", async (req, res) => {
  const ip = getClientIp(req);

  if (!discord.enabled) {
    return res.status(400).json({ success: false, error: tr("err_discord_disabled") });
  }

  if (!req.session.discord) {
    return res.status(401).json({ success: false, error: tr("err_discord_not_logged_in") });
  }

  if (isRateLimited(ip)) {
    return res.status(429).json({ success: false, error: tr("err_rate_limit") });
  }

  const discordUser = req.session.discord;

  try {
    // Refresh roles from Discord (in case they changed)
    let memberData;
    try {
      memberData = await discord.getMemberRoles(discordUser.id);
      // Update session
      req.session.discord.roles = memberData.roles;
      req.session.discord.mappedGroups = memberData.mappedGroups;
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: `${tr("err_discord_fetch")} ${e.message}`,
      });
    }

    // Find TS6 client by IP
    let ts6Clients;
    try {
      ts6Clients = await ts6.findClientsByIp(ip);
    } catch (e) {
      return res.status(503).json({ success: false, error: `${tr("err_ts6_connect")} ${e.message}` });
    }

    if (ts6Clients.length === 0) {
      return res.status(404).json({ success: false, error: tr("err_ts6_not_found") });
    }
    if (ts6Clients.length > 1) {
      return res.status(400).json({ success: false, error: tr("err_ts6_multiple", { count: ts6Clients.length, ip }) });
    }

    const ts6Client = ts6Clients[0];

    if (memberData.mappedGroups.length === 0) {
      return res.json({
        success: true,
        message: tr("msg_discord_no_roles"),
        discordUsername: discordUser.username,
        ts6Nickname: ts6Client.nickname,
        transferred: [],
      });
    }

    const groupsToTransfer = memberData.mappedGroups.filter(
      (g) => !ts6Client.serverGroups.map(String).includes(String(g))
    );

    if (groupsToTransfer.length === 0) {
      return res.json({
        success: true,
        message: tr("msg_synced"),
        discordUsername: discordUser.username,
        ts6Nickname: ts6Client.nickname,
        transferred: [],
        alreadyHad: memberData.mappedGroups,
      });
    }

    const transferred = [];
    const errors = [];

    for (const groupId of groupsToTransfer) {
      try {
        await ts6.addServerGroup(ts6Client.dbid, groupId);
        transferred.push(groupId);
      } catch (e) {
        errors.push({ groupId, error: e.message });
        console.error(`[DISCORD-TRANSFER] Failed to add group ${groupId}:`, e.message);
      }
    }

    setRateLimit(ip);

    res.json({
      success: true,
      message: errors.length === 0 ? tr("msg_success") : tr("msg_partial"),
      discordUsername: discordUser.username,
      ts6Nickname: ts6Client.nickname,
      transferred,
      alreadyHad: memberData.mappedGroups.filter((g) =>
        ts6Client.serverGroups.map(String).includes(String(g))
      ),
      errors,
    });
  } catch (e) {
    console.error("[DISCORD-TRANSFER] Unexpected error:", e);
    res.status(500).json({ success: false, error: `${tr("err_server")} ${e.message}` });
  }
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────
app.listen(CONFIG.web.port, "0.0.0.0", () => {
  console.log(`
  TS Rank Transfer
  ─────────────────────────────────
  Port:     ${CONFIG.web.port}
  Language: ${LANG.toUpperCase()}
  TS3:      ${CONFIG.ts3.host}:${CONFIG.ts3.queryPort}
  TS6:      ${CONFIG.ts6.host}:${CONFIG.ts6.queryPort} (HTTP)
  Discord:  ${discord.enabled ? "OAuth2 Enabled" : "Disabled"}
  ─────────────────────────────────
  `);
});
