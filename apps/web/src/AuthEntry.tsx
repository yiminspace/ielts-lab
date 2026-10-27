import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TokenManager,
  useAuth,
  type AuthConfig,
  type UseAuthOptions,
} from "@yiminlab/authkit";
import {
  VoyageAuthGuard,
  VoyageCallbackHandler,
} from "@yiminlab/authkit/voyage";
import { VOYAGE_APP_DEFAULTS } from "@yiminlab/voyage";
import { VoyageProvider, VoyageStateView } from "@yiminlab/voyage/react";
import App from "./App";
import AccountTools from "./components/AccountTools";
import { RuntimeContext, type ClientConfig } from "./lib/runtime";
import { configureProgressIdentity, resetProgress } from "./lib/progress";
import { createSessionFetch } from "./lib/session-fetch.mjs";

const AUTH_CHANGE = "ielts-auth-change";
class IELTSAuthTokens extends TokenManager {
  clearTokens() {
    super.clearTokens();
    window.dispatchEvent(new Event(AUTH_CHANGE));
  }
  setTokens(access: string, refresh: string, expires: number) {
    super.setTokens(access, refresh, expires);
    window.dispatchEvent(new Event(AUTH_CHANGE));
  }
}
const nativeFetch = window.fetch.bind(window);
type Session = { user: { id: string }; expiresAt: string | number };
function State({
  heading,
  description,
  retry,
}: {
  heading: string;
  description?: string;
  retry?: () => void;
}) {
  return (
    <div className="ielts-access">
      <VoyageStateView
        variant={retry ? "error" : "loading"}
        size="page"
        heading={heading}
        description={description}
        action={
          retry && (
            <button className="vg-btn primary" onClick={retry}>
              重试
            </button>
          )
        }
      />
    </div>
  );
}

function Hosted({ config }: { config: ClientConfig }) {
  const authConfig = useMemo<Partial<AuthConfig>>(
    () => ({
      apiBaseUrl: config.authkitApiUrl,
      callbackPath: "/auth/callback",
    }),
    [config.authkitApiUrl],
  );
  const tokens = useMemo(
    () => new IELTSAuthTokens(undefined, authConfig),
    [authConfig],
  );
  const authOptions = useMemo<UseAuthOptions>(
    () => ({ tokenManager: tokens, config: authConfig, fetchUser: false }),
    [tokens, authConfig],
  );
  const auth = useAuth(authOptions);
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "denied" | "error">(
    "loading",
  );
  const [message, setMessage] = useState("");
  const sessionRef = useRef<Session | null>(null);
  const pending = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  const identityEpoch = useRef(0);
  const clear = useCallback(() => {
    identityEpoch.current++;
    sessionRef.current = null;
    resetProgress();
    setSession(null);
  }, []);
  const establish = useCallback((): Promise<boolean> => {
    if (pending.current) return pending.current;
    const epoch = identityEpoch.current;
    pending.current = (async () => {
      try {
        const token = await tokens.ensureAccessToken();
        if (!token) {
          clear();
          auth.refresh();
          return false;
        }
        const response = await nativeFetch("/api/auth/session", {
          method: "POST",
          credentials: "same-origin",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!mounted.current) return false;
        if (
          epoch !== identityEpoch.current ||
          tokens.getAccessToken() !== token
        ) {
          void nativeFetch("/api/auth/logout", {
            method: "POST",
            credentials: "same-origin",
          });
          return false;
        }
        if (response.status === 403) {
          clear();
          await nativeFetch("/api/auth/logout", {
            method: "POST",
            credentials: "same-origin",
          }).catch(() => {});
          setState("denied");
          return false;
        }
        if (response.status === 401) {
          tokens.clearTokens();
          auth.refresh();
          return false;
        }
        if (!response.ok) throw new Error("无法建立学习会话，请稍后重试。");
        const next = (await response.json()) as Session;
        if (!next.user?.id || !next.expiresAt)
          throw new Error("服务返回的会话无效。");
        // Only the identity verified by the server scopes browser caches.
        if (sessionRef.current?.user.id !== next.user.id)
          configureProgressIdentity(next.user.id);
        sessionRef.current = next;
        setSession(next);
        setState("ready");
        setMessage("");
        return true;
      } catch (error) {
        if (mounted.current) {
          setState("error");
          setMessage(error instanceof Error ? error.message : "连接失败");
        }
        return false;
      } finally {
        pending.current = null;
      }
    })();
    return pending.current;
  }, [tokens, auth.refresh, clear]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      resetProgress();
    };
  }, []);
  useEffect(() => {
    if (auth.isLoading) return;
    if (!auth.isAuthenticated) {
      clear();
      return;
    }
    void establish();
  }, [
    auth.isLoading,
    auth.isAuthenticated,
    auth.tokenVersion,
    establish,
    clear,
  ]);
  useEffect(() => {
    const tokenChange = () => {
      // Clear both memory and the rendered tree immediately on a local logout.
      if (!tokens.getAccessToken()) {
        clear();
        setState("loading");
        void nativeFetch("/api/auth/logout", {
          method: "POST",
          credentials: "same-origin",
        });
      } else {
        const token = tokens.getAccessToken();
        let subject: string | null = null;
        try {
          const payload = token!
            .split(".")[1]
            .replace(/-/g, "+")
            .replace(/_/g, "/");
          subject = JSON.parse(atob(payload)).sub || null;
        } catch {
          /* A malformed token cannot retain a verified cache. */
        }
        if (sessionRef.current?.user.id !== subject) {
          clear();
          setState("loading");
        }
        void establish().then((ok) => {
          if (!ok && tokens.getAccessToken()) void establish();
        });
      }
      auth.refresh();
    };
    const storageChange = (event: StorageEvent) => {
      if (
        event.key === null ||
        Object.values(tokens.getConfig().tokenKeys).includes(event.key)
      ) {
        clear();
        setState("loading");
        tokenChange();
      }
    };
    window.addEventListener(AUTH_CHANGE, tokenChange);
    window.addEventListener("storage", storageChange);
    return () => {
      window.removeEventListener(AUTH_CHANGE, tokenChange);
      window.removeEventListener("storage", storageChange);
    };
  }, [auth.refresh, clear, tokens, establish]);
  useEffect(() => {
    const wrapped = createSessionFetch({
      fetch: nativeFetch,
      origin: location.origin,
      renew: establish,
      denied: () => {
        clear();
        setState("denied");
      },
    });
    window.fetch = wrapped;
    return () => {
      if (window.fetch === wrapped) window.fetch = nativeFetch;
    };
  }, [establish, clear]);
  useEffect(() => {
    if (!session) return;
    const expiry =
      typeof session.expiresAt === "number"
        ? session.expiresAt
        : Date.parse(session.expiresAt);
    const timer = setTimeout(
      () => {
        void establish();
      },
      Math.max(1000, expiry - Date.now() - 60000),
    );
    const resume = () => {
      if (!document.hidden) void establish();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
    };
  }, [session, establish]);

  if (location.pathname === "/auth/callback")
    return <VoyageCallbackHandler config={authConfig} />;
  return (
    <RuntimeContext.Provider
      value={{ config, userId: session?.user.id || null, authOptions }}
    >
      <VoyageAuthGuard
        key={auth.isAuthenticated ? "authenticated" : "anonymous"}
        authOptions={authOptions}
        promptTitle="登录 IELTS Lab"
        promptDescription="个人学习空间，仅向获准账号开放。"
      >
        {state === "denied" ? (
          <div className="ielts-access">
            <AccountTools />
            <VoyageStateView
              variant="error"
              size="page"
              heading="此账号没有访问权限"
              description="IELTS Lab 目前仅向所有者开放。请退出后使用获准账号登录。"
            />
          </div>
        ) : state === "error" ? (
          <State
            heading="连接学习服务失败"
            description={message}
            retry={() => {
              void establish();
            }}
          />
        ) : session && state === "ready" ? (
          <App key={session.user.id} />
        ) : (
          <State heading="正在确认访问权限" />
        )}
      </VoyageAuthGuard>
    </RuntimeContext.Provider>
  );
}

export default function AuthEntry() {
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    nativeFetch("/api/config", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("学习服务配置加载失败");
        const value = await response.json();
        if (typeof value.authRequired !== "boolean")
          throw new Error("学习服务配置无效");
        setConfig(value);
      })
      .catch((error) => {
        if (error.name !== "AbortError") setError(error.message);
      });
    return () => controller.abort();
  }, []);
  return (
    <VoyageProvider
      defaults={VOYAGE_APP_DEFAULTS.ielts}
      storageKey="ielts:vg_prefs"
    >
      {error ? (
        <State heading={error} retry={() => location.reload()} />
      ) : !config ? (
        <State heading="正在连接 IELTS Lab" />
      ) : config.authRequired ? (
        <Hosted config={config} />
      ) : (
        <RuntimeContext.Provider value={{ config, userId: null }}>
          <App />
        </RuntimeContext.Provider>
      )}
    </VoyageProvider>
  );
}
