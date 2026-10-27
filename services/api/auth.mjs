import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (status, message) => Object.assign(new Error(message), { status });
const loopback = (url) =>
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
function configuredOrigin(value, name, allowInsecureTest) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} 必须是完整 URL`);
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(`${name} 必须是没有路径或凭据的 origin`);
  if (
    url.protocol !== "https:" &&
    !(allowInsecureTest && url.protocol === "http:" && loopback(url))
  )
    throw new Error(`${name} 必须使用 HTTPS`);
  return url.origin;
}

/** Opaque, bounded server sessions. No bearer/refresh token enters the cookie or store. */
export function createAuth({
  env = process.env,
  verifyIdentity,
  now = Date.now,
  allowInsecureTest = false,
} = {}) {
  const required = env.IELTS_AUTH_REQUIRED === "1";
  if (env.NODE_ENV === "production" && !required)
    throw new Error("生产环境必须设置 IELTS_AUTH_REQUIRED=1");
  const sessions = new Map();
  const exchanges = new Map();
  let ownerUserId, publicOrigin, authkitApiUrl, secret;
  if (required) {
    ownerUserId = env.OWNER_USER_ID;
    if (!UUID.test(ownerUserId || ""))
      throw new Error("OWNER_USER_ID 必须是有效 UUID");
    secret = env.SESSION_SECRET;
    if (typeof secret !== "string" || Buffer.byteLength(secret) < 32)
      throw new Error("SESSION_SECRET 至少需要 32 字节");
    publicOrigin = configuredOrigin(
      env.PUBLIC_ORIGIN,
      "PUBLIC_ORIGIN",
      allowInsecureTest,
    );
    authkitApiUrl = configuredOrigin(
      env.AUTHKIT_API_URL,
      "AUTHKIT_API_URL",
      allowInsecureTest,
    );
  }
  const secure = required && new URL(publicOrigin).protocol === "https:";
  const cookieName = secure ? "__Host-ielts-session" : "ielts-session";
  const signature = (value) =>
    createHmac("sha256", secret).update(value).digest("base64url");
  const expiredCookie = () =>
    `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
  const cookieValue = (req) => {
    const entries = (req.headers.cookie || "").split(";").map((v) => v.trim());
    const values = entries.filter((v) => v.startsWith(cookieName + "="));
    return values.length === 1 ? values[0].slice(cookieName.length + 1) : "";
  };
  const sessionKey = (req) => {
    const value = cookieValue(req);
    const [id, mac, extra] = value.split(".");
    if (
      !id ||
      !mac ||
      extra ||
      !/^[A-Za-z0-9_-]{43}$/.test(id) ||
      !/^[A-Za-z0-9_-]{43}$/.test(mac)
    )
      return null;
    const expected = signature(id);
    return timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) ? id : null;
  };
  const verify =
    verifyIdentity ||
    (async (bearer) => {
      let response;
      try {
        response = await fetch(`${authkitApiUrl}/api/auth/verify`, {
          headers: {
            Authorization: `Bearer ${bearer}`,
            "X-Required-Scope": "__full__",
          },
          signal: AbortSignal.timeout(8000),
          redirect: "error",
        });
      } catch {
        throw fail(503, "认证服务暂时不可用");
      }
      if (response.status === 401 || response.status === 403)
        throw fail(401, "登录已失效，请重新登录");
      if (!response.ok) throw fail(503, "认证服务暂时不可用");
      const id = response.headers.get("x-user-id");
      // Only a server-verified JWT can establish a cookie; decoding alone proves nothing.
      let claims;
      try {
        claims = JSON.parse(
          Buffer.from(bearer.split(".")[1], "base64url").toString(),
        );
      } catch {
        throw fail(401, "登录凭据格式不正确");
      }
      if (claims.sub !== id || !Number.isFinite(claims.exp))
        throw fail(401, "登录凭据格式不正确");
      return { id, expiresAt: claims.exp * 1000 };
    });
  return {
    required,
    ownerUserId,
    publicOrigin,
    authkitApiUrl,
    publicConfig: {
      authRequired: required,
      authkitApiUrl: required ? authkitApiUrl : null,
      publicOrigin: required ? publicOrigin : null,
    },
    checkRequest(
      req,
      { publicHealth = false, dev = false, frontendPort = 4317 } = {},
    ) {
      const host = req.headers.host || "";
      if (required) {
        if (
          host !== new URL(publicOrigin).host &&
          !(publicHealth && /^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host))
        )
          throw fail(403, "请求 Host 不被允许");
        const origin = req.headers.origin;
        if (
          (origin && origin !== publicOrigin) ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          throw fail(403, "拒绝跨站请求");
        if (
          !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
          origin !== publicOrigin
        )
          throw fail(403, "写入请求需要同源 Origin");
      } else {
        if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(host))
          throw fail(403, "仅允许本机访问");
        const allowed = new Set([`http://${host}`]);
        if (dev)
          for (const h of ["127.0.0.1", "localhost"])
            allowed.add(`http://${h}:${frontendPort}`);
        if (
          (req.headers.origin && !allowed.has(req.headers.origin)) ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          throw fail(403, "拒绝跨站请求");
      }
    },
    requireUser(req) {
      if (!required) return { id: "00000000-0000-4000-8000-000000000001" };
      const key = sessionKey(req),
        session = key && sessions.get(key);
      if (
        !session ||
        session.expiresAt <= now() ||
        session.id !== ownerUserId
      ) {
        if (key) sessions.delete(key);
        throw fail(401, "请先登录");
      }
      return {
        id: session.id,
        expiresAt: new Date(session.expiresAt).toISOString(),
      };
    },
    async exchange(req, res) {
      if (!required)
        return {
          user: { id: "00000000-0000-4000-8000-000000000001" },
          expiresAt: null,
        };
      // A failed account switch must not leave the previous owner's cookie usable.
      const previous = sessionKey(req);
      if (previous) sessions.delete(previous);
      res.setHeader("Set-Cookie", expiredCookie());
      const remote = req.socket.remoteAddress || "local";
      const current = exchanges.get(remote);
      const stamp = now();
      if (current && current.until > stamp && current.count >= 30)
        throw fail(429, "登录请求过多，请稍后重试");
      exchanges.set(
        remote,
        current && current.until > stamp
          ? { ...current, count: current.count + 1 }
          : { count: 1, until: stamp + 300000 },
      );
      for (const [key, value] of exchanges)
        if (value.until <= stamp) exchanges.delete(key);
      for (const [key, value] of sessions)
        if (value.expiresAt <= stamp) sessions.delete(key);
      const match = /^Bearer ([A-Za-z0-9_.-]{1,8192})$/.exec(
        req.headers.authorization || "",
      );
      if (!match) throw fail(401, "需要 AuthKit 登录凭据");
      const identity = await verify(match[1]);
      if (!UUID.test(identity?.id || "")) throw fail(401, "认证身份无效");
      if (identity.id !== ownerUserId)
        throw fail(403, "此应用目前仅向所有者开放");
      const expiresAt = Math.min(stamp + 3600000, Number(identity.expiresAt));
      if (!Number.isFinite(expiresAt) || expiresAt <= stamp)
        throw fail(401, "登录已失效，请重新登录");
      if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, { id: identity.id, expiresAt });
      res.setHeader(
        "Set-Cookie",
        `${cookieName}=${id}.${signature(id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor((expiresAt - stamp) / 1000))}${secure ? "; Secure" : ""}`,
      );
      return {
        user: { id: identity.id },
        expiresAt: new Date(expiresAt).toISOString(),
      };
    },
    logout(req, res) {
      if (required) {
        const id = sessionKey(req);
        if (id) sessions.delete(id);
        res.setHeader("Set-Cookie", expiredCookie());
      }
      return { ok: true };
    },
    close() {
      sessions.clear();
      exchanges.clear();
    },
  };
}
