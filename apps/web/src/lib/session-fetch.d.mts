export function createSessionFetch(options: {
  fetch: typeof fetch;
  origin: string;
  renew: () => Promise<boolean>;
  denied: () => void;
}): typeof fetch;
