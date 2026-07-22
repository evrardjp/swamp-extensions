# Swamp extension AWS SDK bundling incompatibility

## Classification

Swamp extension bundling/runtime defect. This is not a Floci compatibility
issue. Submitted as [swamp lab issue 1324](https://swamp-club.com/lab/1324).

## Versions

- Swamp: `20260720.221015.0-sha.472127ff`
- Deno: `2.8.3`
- Floci: `floci/floci:1.5.11`
- AWS SDK: `npm:@aws-sdk/client-s3@3.1091.0`

## Direct Deno success

With Floci listening on `http://127.0.0.1:4566`, the SDK accepts Floci's S3 XML
when run directly:

```bash
AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test AWS_REGION=us-east-1 \
deno eval 'import { ListBucketsCommand, S3Client } from "npm:@aws-sdk/client-s3@3.1091.0";
const client = new S3Client({ endpoint: "http://127.0.0.1:4566", region: "us-east-1", forcePathStyle: true });
console.log(await client.send(new ListBucketsCommand({})));'
```

Result: `ListBuckets` succeeds and deserializes the valid S3 XML response.

## Swamp model failure

Create a scratch extension containing this minimal `sdk_probe.ts` entrypoint:

```typescript
import { ListBucketsCommand, S3Client } from "npm:@aws-sdk/client-s3@3.1091.0";
import { z } from "npm:zod@4";

const GlobalArgs = z.object({ endpoint: z.string().url() });
export const model = {
  type: "@evrardjp/aws-sdk-probe",
  version: "2026.07.21.1",
  globalArguments: GlobalArgs,
  resources: {},
  methods: {
    status: {
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: { globalArgs: z.infer<typeof GlobalArgs> },
      ) => {
        const client = new S3Client({
          endpoint: context.globalArgs.endpoint,
          region: "us-east-1",
          forcePathStyle: true,
          credentials: { accessKeyId: "test", secretAccessKey: "test" },
        });
        await client.send(new ListBucketsCommand({}));
        return { dataHandles: [] };
      },
    },
  },
};
```

Register it as a model entrypoint in a scratch extension manifest, then run:

```bash
swamp extension source add /path/to/scratch-extension
swamp model create @evrardjp/aws-sdk-probe aws-sdk-probe \
  --global-arg endpoint=http://127.0.0.1:4566 \
swamp model method run aws-sdk-probe status
```

Observed result from the bundled model runtime:

```text
@aws-sdk XML parse error: unexpected content.
Deserialization error: to see the raw response, inspect the hidden field
{error}.$response on this object.
```

`CreateBucket` failed with the same deserialization error inside the bundled
model while direct Deno SDK calls succeeded. The extension now uses a minimal
fetch-based path-style S3 protocol client so Phase 1 can test Floci
independently of this bundling defect.

## Expected

An npm AWS SDK client bundled as part of a Swamp extension should deserialize
the same response identically to the same import executed directly by Deno.
