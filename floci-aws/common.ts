import { z } from "npm:zod@4";

/** Connection settings for the Floci HTTP endpoint. */
export const FlociConnectionSchema = z.object({
  endpoint: z.string().url().default("http://127.0.0.1:4566").describe(
    "Floci endpoint URL",
  ),
  region: z.string().min(1).default("us-east-1"),
  accessKeyId: z.string().min(1).optional().meta({ sensitive: true }),
  secretAccessKey: z.string().min(1).optional().meta({ sensitive: true }),
  sessionToken: z.string().min(1).optional().meta({ sensitive: true }),
});

export type FlociConnection = z.infer<typeof FlociConnectionSchema>;
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ModelContext<T> {
  globalArgs: T;
  logger: {
    info(message: string, properties?: Record<string, unknown>): void;
  };
  writeResource(
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ): Promise<unknown>;
  fetch?: FetchLike;
}

export function fetcher(context: ModelContext<FlociConnection>): FetchLike {
  return context.fetch ?? fetch;
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

export function s3Url(
  endpoint: string,
  bucket: string,
  key?: string,
  query?: URLSearchParams,
): URL {
  const url = new URL(endpoint);
  const basePath = url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath}/${encodeURIComponent(bucket)}/${
    key === undefined ? "" : encodePath(key)
  }`;
  url.search = query?.toString() ?? "";
  return url;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function hmac(
  key: Uint8Array<ArrayBuffer>,
  value: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      cryptoKey,
      new TextEncoder().encode(value),
    ),
  );
}

function canonicalQuery(url: URL): string {
  return Array.from(url.searchParams.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    )
    .map(([key, value]) =>
      `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    )
    .join("&");
}

async function signS3Request(
  context: ModelContext<FlociConnection>,
  method: string,
  url: URL,
  headers: Headers,
  body: string,
): Promise<void> {
  const accessKeyId = context.globalArgs.accessKeyId ??
    Deno.env.get("AWS_ACCESS_KEY_ID") ?? "test";
  const secretAccessKey = context.globalArgs.secretAccessKey ??
    Deno.env.get("AWS_SECRET_ACCESS_KEY") ?? "test";
  const sessionToken = context.globalArgs.sessionToken ??
    Deno.env.get("AWS_SESSION_TOKEN");
  const timestamp = new Date().toISOString().replaceAll(/[:-]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);
  const payloadHash = await sha256(body);
  headers.set("x-amz-content-sha256", payloadHash);
  headers.set("x-amz-date", timestamp);
  if (sessionToken) headers.set("x-amz-security-token", sessionToken);

  const signedHeaderNames = [
    "host",
    "x-amz-content-sha256",
    "x-amz-date",
    ...(sessionToken ? ["x-amz-security-token"] : []),
  ];
  const canonicalHeaders = [
    `host:${url.host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${timestamp}`,
    ...(sessionToken ? [`x-amz-security-token:${sessionToken}`] : []),
  ].join("\n") + "\n";
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaderNames.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${date}/${context.globalArgs.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    await sha256(canonicalRequest),
  ].join("\n");
  const dateKey = await hmac(
    new TextEncoder().encode(`AWS4${secretAccessKey}`),
    date,
  );
  const regionKey = await hmac(dateKey, context.globalArgs.region);
  const serviceKey = await hmac(regionKey, "s3");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = Array.from(
    await hmac(signingKey, stringToSign),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  headers.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${
      signedHeaderNames.join(";")
    }, Signature=${signature}`,
  );
}

export async function s3Request(
  context: ModelContext<FlociConnection>,
  method: string,
  bucket: string,
  options: {
    key?: string;
    query?: URLSearchParams;
    headers?: HeadersInit;
    body?: string;
  } = {},
): Promise<Response> {
  const url = s3Url(
    context.globalArgs.endpoint,
    bucket,
    options.key,
    options.query,
  );
  const headers = new Headers(options.headers);
  const body = options.body ?? "";
  await signS3Request(context, method, url, headers, body);
  const response = await fetcher(context)(
    url,
    {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
    },
  );
  if (response.ok) return response;
  const detail = method === "HEAD"
    ? ""
    : (await response.text()).replaceAll(/\s+/g, " ").slice(0, 1000);
  throw new Error(
    `Floci S3 ${method} failed with HTTP ${response.status}${
      detail ? `: ${detail}` : ""
    }`,
  );
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function normalizeEtag(etag: string | null | undefined): string | null {
  return etag ?? null;
}

export function decodeXml(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function xmlValue(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeXml(match[1]) : null;
}
