import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../../services/api/index.mjs";
import { provisionDatabase } from "../../services/api/scripts/provision-db.mjs";
import { migrate } from "../../services/api/scripts/migrate.mjs";

export const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export async function startBrowserFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ielts-browser-"));
  const adminURL = process.env.IELTS_TEST_ADMIN_DATABASE_URL;
  const suffix = `browser_${process.pid}_${Date.now()}`;
  const db = `ielts_${suffix}`,
    runtimeRole = `ielts_app_${suffix}`,
    migrationRole = `ielts_migrate_${suffix}`;
  const origin = `http://127.0.0.1:${process.env.IELTS_BROWSER_PORT}`;
  let admin, app;
  async function stop() {
    if (app) {
      await new Promise((resolve) => {
        app.server.closeAllConnections();
        app.server.close(resolve);
      });
      await app.store?.close?.();
    }
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      for (const role of [runtimeRole, migrationRole])
        await admin.query(`DROP ROLE IF EXISTS "${role}"`);
      await admin.end();
    }
    await fs.rm(root, { recursive: true, force: true });
  }
  try {
    const env = {};
    if (adminURL) {
      const { Client } = await import("pg");
      admin = new Client({ connectionString: adminURL });
      await admin.connect();
      const makeURL = (name) => {
        const url = new URL(adminURL);
        url.username = name;
        url.password = "original-browser-test-only";
        url.pathname = `/${db}`;
        return url.toString();
      };
      const runtimeURL = makeURL(runtimeRole),
        migrationURL = makeURL(migrationRole);
      await provisionDatabase({ adminURL, migrationURL, runtimeURL });
      await migrate({ connectionString: migrationURL, runtimeRole });
      Object.assign(env, {
        NODE_ENV: "test",
        IELTS_AUTH_REQUIRED: "1",
        OWNER_USER_ID: owner,
        SESSION_SECRET: "original-browser-synthetic-test-secret",
        PUBLIC_ORIGIN: origin,
        AUTHKIT_API_URL: "https://auth.example.invalid",
        RECORDINGS_ROOT: path.join(root, "recordings"),
        DATABASE_URL: runtimeURL,
      });
    }
    app = await createApp({
      projectRoot: root,
      forceDemo: true,
      env,
      dev: true,
      frontendPort: Number(process.env.IELTS_BROWSER_PORT),
      allowInsecureTest: true,
      // Synthetic identity verifier is injected only in this test constructor.
      // Real routing, owner checks, cookies, CAS, PostgreSQL and recordings are exercised.
      verifyIdentity: async (token) => {
        const payload = JSON.parse(
          Buffer.from(token.split(".")[1], "base64url").toString(),
        );
        return { id: payload.sub, expiresAt: payload.exp * 1000 };
      },
    });
    await new Promise((resolve) =>
      app.server.listen(
        Number(process.env.IELTS_BROWSER_API_PORT),
        "127.0.0.1",
        resolve,
      ),
    );
    return { stop, hosted: !!adminURL, app, origin };
  } catch (error) {
    await stop();
    throw error;
  }
}
export async function seedIdentity(context, id = owner) {
  await context.addInitScript(
    ({ id }) => {
      const encode = (value) =>
        btoa(JSON.stringify(value))
          .replace(/=/g, "")
          .replace(/\+/g, "-")
          .replace(/\//g, "_");
      const token = `${encode({ alg: "original-test" })}.${encode({ sub: id, exp: Math.floor(Date.now() / 1000) + 3600 })}.original-test-signature`;
      localStorage.setItem("authkit_access_token", token);
      localStorage.setItem("authkit_refresh_token", "original-test-refresh");
      localStorage.setItem(
        "authkit_token_expiry",
        String(Date.now() + 3600000),
      );
    },
    { id },
  );
  await context.route("https://auth.example.invalid/**", (route) =>
    route.fulfill({
      status: 200,
      json: { ok: true },
      headers: {
        "Access-Control-Allow-Origin": `http://127.0.0.1:${process.env.IELTS_BROWSER_PORT}`,
        "Access-Control-Allow-Headers": "authorization, content-type",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      },
    }),
  );
}
export async function fakeMicrophone(context) {
  const audio = await fs.readFile(
    new URL("../../services/api/assets/demo-speaking-0.wav", import.meta.url),
  );
  await context.addInitScript(
    ({ audio }) => {
      const bytes = Uint8Array.from(atob(audio), (char) => char.charCodeAt(0));
      class OriginalRecorder {
        static isTypeSupported() {
          return false;
        }
        mimeType = "audio/wav";
        state = "inactive";
        start() {
          this.state = "recording";
        }
        stop() {
          this.state = "inactive";
          queueMicrotask(() => {
            this.ondataavailable?.({
              data: new Blob([bytes], { type: "audio/wav" }),
            });
            this.onstop?.();
          });
        }
      }
      window.MediaRecorder = OriginalRecorder;
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
        },
      });
    },
    { audio: audio.toString("base64") },
  );
}
