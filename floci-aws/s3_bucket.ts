import { z } from "npm:zod@4";
import {
  FlociConnectionSchema,
  isoNow,
  type ModelContext,
  s3Request,
} from "./common.ts";

const BucketNameSchema = z.string().min(3).max(63).regex(
  /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/,
  "bucket must use lowercase letters, digits, dots, and hyphens",
);

/** Connection and bucket arguments for the bucket lifecycle model. */
export const S3BucketGlobalArgsSchema = FlociConnectionSchema.extend({
  bucket: BucketNameSchema,
});
/** Persisted bucket lifecycle observation. */
export const S3BucketResourceSchema = z.object({
  bucket: BucketNameSchema,
  region: z.string(),
  exists: z.boolean(),
  operation: z.enum(["create", "head", "sync", "delete"]),
  bucketRegion: z.string().nullable(),
  observedAt: z.iso.datetime(),
});

type GlobalArgs = z.infer<typeof S3BucketGlobalArgsSchema>;
type Context = ModelContext<GlobalArgs>;

async function persist(
  context: Context,
  operation: "create" | "head" | "sync" | "delete",
  exists: boolean,
  bucketRegion?: string | null,
) {
  const handle = await context.writeResource("bucket", "state", {
    bucket: context.globalArgs.bucket,
    region: context.globalArgs.region,
    exists,
    operation,
    bucketRegion: bucketRegion ?? null,
    observedAt: isoNow(),
  });
  return { dataHandles: [handle] };
}

async function observe(context: Context, operation: "head" | "sync") {
  const response = await s3Request(
    context,
    "HEAD",
    context.globalArgs.bucket,
  );
  return await persist(
    context,
    operation,
    true,
    response.headers.get("x-amz-bucket-region"),
  );
}

/** Manages one S3 bucket through Floci's path-style HTTP protocol. */
export const model = {
  type: "@evrardjp/floci-aws/s3-bucket",
  version: "2026.07.21.1",
  globalArguments: S3BucketGlobalArgsSchema,
  resources: {
    bucket: {
      description: "Observed S3 bucket lifecycle state",
      schema: S3BucketResourceSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    create: {
      description: "Create the configured S3 bucket",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Context) => {
        const region = context.globalArgs.region;
        const body = region === "us-east-1"
          ? ""
          : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`;
        await s3Request(context, "PUT", context.globalArgs.bucket, {
          body,
          headers: body ? { "content-type": "application/xml" } : {},
        });
        return await persist(context, "create", true, region);
      },
    },
    head: {
      description: "Read current bucket metadata",
      arguments: z.object({}),
      execute: (_args: Record<string, never>, context: Context) =>
        observe(context, "head"),
    },
    sync: {
      description: "Synchronize persisted bucket state from S3",
      arguments: z.object({}),
      execute: (_args: Record<string, never>, context: Context) =>
        observe(context, "sync"),
    },
    delete: {
      description: "Delete the configured empty S3 bucket",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Context) => {
        await s3Request(context, "DELETE", context.globalArgs.bucket);
        return await persist(context, "delete", false);
      },
    },
  },
};
