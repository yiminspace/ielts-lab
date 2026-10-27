/** Retry same-origin application API requests once after renewing the HttpOnly session.
 * Tokens never enter URLs; a cloned Request keeps upload/JSON bodies retryable. */
export function createSessionFetch({
  fetch: nativeFetch,
  origin,
  renew,
  denied,
}) {
  let renewal;
  const refresh = () =>
    (renewal ||= Promise.resolve()
      .then(renew)
      .finally(() => {
        renewal = undefined;
      }));
  return async (input, init) => {
    const request = new Request(
      typeof input === "string" ? new URL(input, origin) : input,
      init,
    );
    const url = new URL(request.url);
    if (
      url.origin !== origin ||
      !url.pathname.startsWith("/api/") ||
      url.pathname.startsWith("/api/auth/") ||
      url.pathname === "/api/config"
    ) {
      return nativeFetch(request);
    }
    const retry = request.clone();
    let response = await nativeFetch(request);
    if (response.status === 401 && (await refresh()))
      response = await nativeFetch(retry);
    if (response.status === 403) denied();
    return response;
  };
}
