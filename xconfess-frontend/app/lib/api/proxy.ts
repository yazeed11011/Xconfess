import 'server-only';

import { getApiBaseUrl } from '@/app/lib/config';
import { getOrCreateRequestId } from '@/app/lib/utils/requestId';

export interface ProxyRequestOptions extends RequestInit {
  timeout?: number;
  /**
   * Forward the caller's cookies to the backend and surface Set-Cookie headers
   * back to the caller. Defaults to true so browser proxy routes keep the
   * session cookie working end-to-end.
   */
  forwardCredentials?: boolean;
}

export interface ProxyResult<T = unknown> {
  data: T;
  status: number;
  headers: Headers;
  /** Set-Cookie values returned by the backend, ready to re-emit. */
  setCookies: string[];
}

const DEFAULT_TIMEOUT = 30000;
const FRONTEND_HOST_ENV_KEYS = [
  'FRONTEND_URL',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_SITE_URL',
  'VERCEL_URL',
  'VERCEL_BRANCH_URL',
  'VERCEL_PROJECT_PRODUCTION_URL',
];

export interface BackendRoute {
  url: string;
  requestId: string;
}

/**
 * Secret-free description of the resolved backend route for diagnostics.
 * Never includes query strings, credentials, or auth headers.
 */
export interface BackendRouteDiagnostics {
  origin: string;
  host: string;
  endpoint: string;
  requestId: string;
}

export function describeBackendRoute(
  route: BackendRoute,
  endpoint: string,
): BackendRouteDiagnostics {
  const parsed = new URL(route.url);
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return {
    origin: parsed.origin,
    host: parsed.host.toLowerCase(),
    endpoint: normalizedEndpoint,
    requestId: route.requestId,
  };
}

export function resolveBackendRoute(
  request: Request,
  endpoint: string,
): BackendRoute {
  const requestId = getOrCreateRequestId(request);
  const baseApiUrl = getApiBaseUrl();
  const requestUrl = new URL(request.url);
  const backendApiUrl = new URL(baseApiUrl);
  const frontendHosts = resolveFrontendHosts(requestUrl);

  if (frontendHosts.has(backendApiUrl.host.toLowerCase())) {
    throw Object.assign(
      new Error(
        'Server misconfiguration: BACKEND_API_URL points to the frontend instead of the Render backend.',
      ),
      { code: 'BACKEND_API_URL_SELF_REFERENCE', status: 503, requestId },
    );
  }

  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return {
    url: `${baseApiUrl}${normalizedEndpoint}`,
    requestId,
  };
}

export function getSessionAuthorization(request: Request): string | undefined {
  const sessionCookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith('xconfess_session='));
  const token = sessionCookie?.slice('xconfess_session='.length);
  return token ? `Bearer ${token}` : undefined;
}

function resolveFrontendHosts(requestUrl: URL): Set<string> {
  const hosts = new Set<string>([requestUrl.host.toLowerCase()]);

  for (const key of FRONTEND_HOST_ENV_KEYS) {
    const host = normalizeHost(process.env[key]);
    if (host) hosts.add(host);
  }

  return hosts;
}

function normalizeHost(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)
      .host
      .toLowerCase();
  } catch {
    return null;
  }
}

export function methodNotAllowed(method: string, allowed: string[]): Response {
  const allowHeader = allowed.join(', ');
  return new Response(
    JSON.stringify({
      code: 'METHOD_NOT_ALLOWED',
      message: `Method ${method} is not allowed. Use ${allowHeader}.`,
    }),
    {
      status: 405,
      headers: {
        'Content-Type': 'application/json',
        Allow: allowHeader,
      },
    },
  );
}

// Methods a proxy route may need an explicit 405 for. OPTIONS/HEAD are left to
// Next.js so CORS preflight and HEAD-of-GET keep working.
const STANDARD_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/**
 * Build route handlers that return a standardized 405 for every standard HTTP
 * method not in `allowed`. Spread the result into a route module, e.g.:
 *
 *   export const { PUT, PATCH, DELETE } = methodNotAllowedHandlers(['GET', 'POST']);
 */
export function methodNotAllowedHandlers(
  allowed: string[],
): Record<string, () => Response> {
  const allowedSet = new Set(allowed.map((method) => method.toUpperCase()));
  const handlers: Record<string, () => Response> = {};
  for (const method of STANDARD_HTTP_METHODS) {
    if (!allowedSet.has(method)) {
      handlers[method] = () => methodNotAllowed(method, allowed);
    }
  }
  return handlers;
}

export async function proxyRequest<T = unknown>(
  targetUrl: string,
  options: ProxyRequestOptions = {}
): Promise<T> {
  const result = await proxyRequestWithResponse<T>(targetUrl, options);
  return result.data;
}

/**
 * Like {@link proxyRequest} but returns the status, headers, and Set-Cookie
 * values alongside the parsed body so route handlers can re-emit cookies.
 */
export async function proxyRequestWithResponse<T = unknown>(
  targetUrl: string,
  options: ProxyRequestOptions = {}
): Promise<ProxyResult<T>> {
  const {
    timeout = DEFAULT_TIMEOUT,
    forwardCredentials = true,
    ...fetchOptions
  } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  // Propagate caller/client cancellation signal immediately
  if (fetchOptions.signal) {
    if (fetchOptions.signal.aborted) {
      controller.abort();
    } else {
      fetchOptions.signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
    }
  }

  try {
    const response = await fetch(targetUrl, {
      ...fetchOptions,
      credentials: forwardCredentials
        ? (fetchOptions.credentials ?? 'include')
        : fetchOptions.credentials,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...fetchOptions.headers,
      },
    });

    clearTimeout(timeoutId);

    const setCookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [];

    if (!response.ok) {
      const errorBody = await response
        .json()
        .catch(() => ({ message: 'Request failed' }));
      throw Object.assign(
        new Error(errorBody.message || `HTTP ${response.status}`),
        { status: response.status, setCookies },
      );
    }

    const data =
      response.status === 204 ? ({} as T) : await response.json();

    return {
      data,
      status: response.status,
      headers: response.headers,
      setCookies,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw error;
  }
}

export function createProxyHandler(baseUrl: string) {
  return async function proxy<T>(
    endpoint: string,
    options: ProxyRequestOptions = {}
  ): Promise<T> {
    const url = endpoint.startsWith('/') ? `${baseUrl}${endpoint}` : `${baseUrl}/${endpoint}`;
    return proxyRequest<T>(url, options);
  };
}

export function createProxyHandlerWithResponse(baseUrl: string) {
  return async function proxy<T>(
    endpoint: string,
    options: ProxyRequestOptions = {}
  ): Promise<ProxyResult<T>> {
    const url = endpoint.startsWith('/') ? `${baseUrl}${endpoint}` : `${baseUrl}/${endpoint}`;
    return proxyRequestWithResponse<T>(url, options);
  };
}
