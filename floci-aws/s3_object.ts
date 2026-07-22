import { z } from "npm:zod@4";
import {
  FlociConnectionSchema,
  isoNow,
  type ModelContext,
  normalizeEtag,
  s3Request,
  xmlValue,
} from "./common.ts";

/** Connection, bucket, and key arguments for the object model. */
export const S3ObjectGlobalArgsSchema = FlociConnectionSchema.extend({
  bucket: z.string().min(3).max(63),
  key: z.string().min(1).max(1024),
});
const ConditionsSchema = z.object({
  ifMatch: z.string().min(1).optional(),
  ifNoneMatch: z.string().min(1).optional(),
}).refine((value) => !(value.ifMatch && value.ifNoneMatch), {
  message: "ifMatch and ifNoneMatch are mutually exclusive",
});
/** Input contract for conditional UTF-8 object writes. */
export const PutObjectArgsSchema = ConditionsSchema.extend({
  body: z.string().describe("UTF-8 object body; not persisted in Swamp data"),
  contentType: z.string().min(1).default("text/plain; charset=utf-8"),
});
/** Shared If-Match and If-None-Match input contract. */
export const ObjectConditionsSchema = ConditionsSchema;
/** Input contract for bounded object listings. */
export const ListObjectArgsSchema = z.object({
  prefix: z.string().max(1024).optional(),
  maxKeys: z.number().int().min(1).max(1000).default(100),
});
/** Input contract for deleting every object beneath a non-empty prefix. */
export const DeletePrefixArgsSchema = z.object({
  prefix: z.string().min(1).max(1024),
  maxObjects: z.number().int().min(1).max(100_000).default(10_000),
});

const ObjectStateSchema = z.object({
  bucket: z.string(),
  key: z.string(),
  operation: z.enum(["put", "head", "get", "delete"]),
  exists: z.boolean(),
  etag: z.string().nullable(),
  size: z.number().int().nonnegative().nullable(),
  contentType: z.string().nullable(),
  bodySha256: z.string().nullable(),
  observedAt: z.iso.datetime(),
});
const ObjectListSchema = z.object({
  bucket: z.string(),
  prefix: z.string(),
  objects: z.array(z.object({
    key: z.string(),
    etag: z.string().nullable(),
    size: z.number().int().nonnegative(),
    lastModified: z.string().nullable(),
  })),
  truncated: z.boolean(),
  observedAt: z.iso.datetime(),
});
const ObjectDeletionSchema = z.object({
  bucket: z.string(),
  prefix: z.string(),
  deleted: z.number().int().nonnegative(),
  truncated: z.boolean(),
  observedAt: z.iso.datetime(),
});

type GlobalArgs = z.infer<typeof S3ObjectGlobalArgsSchema>;
type Context = ModelContext<GlobalArgs>;

function conditionHeaders(args: {
  ifMatch?: string;
  ifNoneMatch?: string;
}): Headers {
  const headers = new Headers();
  if (args.ifMatch) headers.set("if-match", args.ifMatch);
  if (args.ifNoneMatch) headers.set("if-none-match", args.ifNoneMatch);
  return headers;
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

async function persist(
  context: Context,
  operation: "put" | "head" | "get" | "delete",
  values: {
    exists: boolean;
    etag?: string | null;
    size?: number;
    contentType?: string | null;
    bodySha256?: string;
  },
) {
  const handle = await context.writeResource("object", "state", {
    bucket: context.globalArgs.bucket,
    key: context.globalArgs.key,
    operation,
    exists: values.exists,
    etag: normalizeEtag(values.etag),
    size: values.size ?? null,
    contentType: values.contentType ?? null,
    bodySha256: values.bodySha256 ?? null,
    observedAt: isoNow(),
  });
  return { dataHandles: [handle] };
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Manages one S3 object without persisting request credentials or object bodies. */
export const model = {
  type: "@evrardjp/floci-aws/s3-object",
  version: "2026.07.21.1",
  globalArguments: S3ObjectGlobalArgsSchema,
  resources: {
    object: {
      description: "S3 object metadata and content digest",
      schema: ObjectStateSchema,
      lifetime: "infinite",
      garbageCollection: 30,
    },
    objects: {
      description: "Bounded S3 object listing",
      schema: ObjectListSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
    deletion: {
      description: "Summary of a prefix-wide object deletion",
      schema: ObjectDeletionSchema,
      lifetime: "30d",
      garbageCollection: 10,
    },
  },
  methods: {
    put: {
      description: "Put a UTF-8 object with optional conditional headers",
      arguments: PutObjectArgsSchema,
      execute: async (
        args: z.infer<typeof PutObjectArgsSchema>,
        context: Context,
      ) => {
        const headers = conditionHeaders(args);
        headers.set("content-type", args.contentType);
        const response = await s3Request(
          context,
          "PUT",
          context.globalArgs.bucket,
          { key: context.globalArgs.key, headers, body: args.body },
        );
        return await persist(context, "put", {
          exists: true,
          etag: response.headers.get("etag"),
          size: new TextEncoder().encode(args.body).byteLength,
          contentType: args.contentType,
          bodySha256: await sha256(args.body),
        });
      },
    },
    head: {
      description: "Read object metadata with optional conditional headers",
      arguments: ObjectConditionsSchema,
      execute: async (
        args: z.infer<typeof ObjectConditionsSchema>,
        context: Context,
      ) => {
        const response = await s3Request(
          context,
          "HEAD",
          context.globalArgs.bucket,
          { key: context.globalArgs.key, headers: conditionHeaders(args) },
        );
        return await persist(context, "head", {
          exists: true,
          etag: response.headers.get("etag"),
          size: contentLength(response),
          contentType: response.headers.get("content-type"),
        });
      },
    },
    get: {
      description: "Get and verify object content without persisting its body",
      arguments: ObjectConditionsSchema,
      execute: async (
        args: z.infer<typeof ObjectConditionsSchema>,
        context: Context,
      ) => {
        const response = await s3Request(
          context,
          "GET",
          context.globalArgs.bucket,
          { key: context.globalArgs.key, headers: conditionHeaders(args) },
        );
        const body = await response.text();
        return await persist(context, "get", {
          exists: true,
          etag: response.headers.get("etag"),
          size: new TextEncoder().encode(body).byteLength,
          contentType: response.headers.get("content-type"),
          bodySha256: await sha256(body),
        });
      },
    },
    list: {
      description: "List at most 1000 objects in the configured bucket",
      arguments: ListObjectArgsSchema,
      execute: async (
        args: z.infer<typeof ListObjectArgsSchema>,
        context: Context,
      ) => {
        const prefix = args.prefix ?? "";
        const query = new URLSearchParams({
          "list-type": "2",
          prefix,
          "max-keys": String(args.maxKeys),
        });
        const response = await s3Request(
          context,
          "GET",
          context.globalArgs.bucket,
          { query },
        );
        const xml = await response.text();
        const objects = Array.from(
          xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g),
          (match) => ({
            key: xmlValue(match[1], "Key") ?? "",
            etag: normalizeEtag(xmlValue(match[1], "ETag")),
            size: Number(xmlValue(match[1], "Size") ?? 0),
            lastModified: xmlValue(match[1], "LastModified"),
          }),
        );
        const handle = await context.writeResource("objects", "list", {
          bucket: context.globalArgs.bucket,
          prefix,
          objects,
          truncated: xmlValue(xml, "IsTruncated") === "true",
          observedAt: isoNow(),
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Delete the object, optionally only when its ETag matches",
      arguments: z.object({ ifMatch: z.string().min(1).optional() }),
      execute: async (args: { ifMatch?: string }, context: Context) => {
        await s3Request(context, "DELETE", context.globalArgs.bucket, {
          key: context.globalArgs.key,
          headers: conditionHeaders(args),
        });
        return await persist(context, "delete", { exists: false });
      },
    },
    deletePrefix: {
      description: "Delete every object beneath a non-empty prefix",
      arguments: DeletePrefixArgsSchema,
      execute: async (
        args: z.infer<typeof DeletePrefixArgsSchema>,
        context: Context,
      ) => {
        let deleted = 0;
        let truncated = false;
        while (deleted < args.maxObjects) {
          const maxKeys = Math.min(1000, args.maxObjects - deleted);
          const query = new URLSearchParams({
            "list-type": "2",
            prefix: args.prefix,
            "max-keys": String(maxKeys),
          });
          const response = await s3Request(
            context,
            "GET",
            context.globalArgs.bucket,
            { query },
          );
          const xml = await response.text();
          const keys = Array.from(
            xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g),
            (match) => xmlValue(match[1], "Key") ?? "",
          ).filter(Boolean);
          if (keys.length === 0) break;

          for (let index = 0; index < keys.length; index += 20) {
            await Promise.all(
              keys.slice(index, index + 20).map((key) =>
                s3Request(context, "DELETE", context.globalArgs.bucket, { key })
              ),
            );
          }
          deleted += keys.length;
          if (keys.length < maxKeys) break;
        }

        if (deleted === args.maxObjects) {
          const query = new URLSearchParams({
            "list-type": "2",
            prefix: args.prefix,
            "max-keys": "1",
          });
          const response = await s3Request(
            context,
            "GET",
            context.globalArgs.bucket,
            { query },
          );
          truncated = /<Contents>[\s\S]*?<\/Contents>/.test(
            await response.text(),
          );
        }

        const handle = await context.writeResource(
          "deletion",
          "prefix-delete",
          {
            bucket: context.globalArgs.bucket,
            prefix: args.prefix,
            deleted,
            truncated,
            observedAt: isoNow(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
