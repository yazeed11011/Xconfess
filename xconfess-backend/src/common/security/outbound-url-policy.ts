import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress, LookupFunction, LookupOptions } from 'node:dns';
import { isIP } from 'node:net';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import axios from 'axios';

export class OutboundUrlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboundUrlPolicyError';
  }
}

type ResolveHost = (hostname: string) => Promise<LookupAddress[]>;

const resolveHost: ResolveHost = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

const blockedIpv4Ranges: Array<[bigint, number]> = [
  [0x00000000n, 8],
  [0x0a000000n, 8],
  [0x64400000n, 10],
  [0x7f000000n, 8],
  [0xa9fe0000n, 16],
  [0xac100000n, 12],
  [0xc0000000n, 24],
  [0xc0000200n, 24],
  [0xc0586300n, 24],
  [0xc0a80000n, 16],
  [0xc6120000n, 15],
  [0xc6336400n, 24],
  [0xcb007100n, 24],
  [0xe0000000n, 4],
  [0xf0000000n, 4],
];
const redirectStatuses = new Set([300, 301, 302, 303, 305, 307, 308]);

function ipv4ToBigInt(address: string): bigint {
  return address
    .split('.')
    .reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n);
}

function ipv6ToBigInt(address: string): bigint {
  let normalized = address.toLowerCase();
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const ipv4 = ipv4ToBigInt(normalized.slice(lastColon + 1));
    normalized = `${normalized.slice(0, lastColon)}:${(ipv4 >> 16n).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
  }

  const halves = normalized.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
      : left;

  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group || '0'}`),
    0n,
  );
}

function isInRange(
  address: bigint,
  network: bigint,
  prefix: number,
  bits: number,
): boolean {
  return address >> BigInt(bits - prefix) === network >> BigInt(bits - prefix);
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4ToBigInt(address);
    return !blockedIpv4Ranges.some(([network, prefix]) =>
      isInRange(value, network, prefix, 32),
    );
  }

  if (family !== 6) return false;

  const value = ipv6ToBigInt(address);
  const isGlobalUnicast = isInRange(
    value,
    0x20000000000000000000000000000000n,
    3,
    128,
  );
  const isSpecialPurpose =
    isInRange(value, 0x20010db8000000000000000000000000n, 32, 128) ||
    isInRange(value, 0x20010000000000000000000000000000n, 23, 128) ||
    isInRange(value, 0x20020000000000000000000000000000n, 16, 128) ||
    isInRange(value, 0x3fff0000000000000000000000000000n, 20, 128);

  return isGlobalUnicast && !isSpecialPurpose;
}

function configuredOrigins(): Set<string> {
  const configured = (process.env.OUTBOUND_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return new Set(
    configured.map((origin) => {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        throw new OutboundUrlPolicyError(
          'OUTBOUND_ALLOWED_ORIGINS contains an invalid origin',
        );
      }

      if (parsed.protocol !== 'https:' || parsed.origin !== origin) {
        throw new OutboundUrlPolicyError(
          'OUTBOUND_ALLOWED_ORIGINS must contain exact HTTPS origins without paths',
        );
      }
      return parsed.origin;
    }),
  );
}

export function assertOutboundUrlAllowed(input: string | URL): URL {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new OutboundUrlPolicyError('Outbound URL is invalid');
  }

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !configuredOrigins().has(url.origin)
  ) {
    throw new OutboundUrlPolicyError(
      'Outbound URL is not authorized by OUTBOUND_ALLOWED_ORIGINS',
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new OutboundUrlPolicyError(
      'Outbound URL resolves to a prohibited address',
    );
  }

  return url;
}

export function createPinnedLookup(
  resolve: ResolveHost = resolveHost,
): LookupFunction {
  type LookupCallback = (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void;

  const lookup = (
    hostname: string,
    options: number | LookupOptions | LookupCallback,
    callback?: LookupCallback,
  ): void => {
    const done = typeof options === 'function' ? options : callback;
    if (!done) return;
    const lookupOptions =
      typeof options === 'number'
        ? { family: options }
        : typeof options === 'function'
          ? {}
          : options;

    void resolve(hostname)
      .then((addresses) => {
        if (
          addresses.length === 0 ||
          addresses.some(({ address }) => !isPublicAddress(address))
        ) {
          throw new OutboundUrlPolicyError(
            'Outbound URL resolves to a prohibited address',
          );
        }

        const candidates = lookupOptions.family
          ? addresses.filter(({ family }) => family === lookupOptions.family)
          : addresses;
        const selected = candidates[0];
        if (!selected) {
          throw new OutboundUrlPolicyError(
            'Outbound URL has no address in the requested IP family',
          );
        }

        if ('all' in lookupOptions && lookupOptions.all) {
          done(null, [selected]);
        } else {
          done(null, selected.address, selected.family);
        }
      })
      .catch((error: unknown) => {
        done(
          error instanceof Error
            ? (error as NodeJS.ErrnoException)
            : new Error('Outbound DNS resolution failed'),
          '',
        );
      });
  };

  return lookup as LookupFunction;
}

export async function outboundFetch(
  input: string | URL,
  init: Pick<RequestInit, 'method' | 'headers' | 'body' | 'signal'> & {
    timeoutMs?: number;
  } = {},
): Promise<Response> {
  const url = assertOutboundUrlAllowed(input);
  const lookup = createPinnedLookup();
  const httpAgent = new HttpAgent({ keepAlive: false, lookup });
  const httpsAgent = new HttpsAgent({ keepAlive: false, lookup });
  const requestHeaders = Object.fromEntries(new Headers(init.headers).entries());

  try {
    const response = await axios.request<Buffer>({
      url: url.href,
      method: init.method ?? 'GET',
      headers: requestHeaders,
      data: init.body,
      signal: init.signal ?? undefined,
      timeout: init.timeoutMs ?? 10_000,
      maxRedirects: 0,
      proxy: false,
      validateStatus: () => true,
      responseType: 'arraybuffer',
      httpAgent,
      httpsAgent,
    });

    if (redirectStatuses.has(response.status)) {
      throw new OutboundUrlPolicyError('Outbound redirects are not permitted');
    }

    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (
        value !== undefined &&
        !['content-encoding', 'content-length'].includes(name.toLowerCase())
      ) {
        headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
      }
    }

    const bodylessStatus = [204, 205, 304].includes(response.status);
    return new Response(
      bodylessStatus ? null : Buffer.from(response.data),
      {
        status: response.status,
        statusText: response.statusText,
        headers,
      },
    );
  } finally {
    httpAgent.destroy();
    httpsAgent.destroy();
  }
}