/**
 * Inventory report for @evrardjp/ssh-ca OpenSSH CA model instances.
 *
 * The report does not deploy configuration. It summarizes Swamp data so other
 * extensions or humans can consume CA public keys, certificates, and KRLs.
 *
 * @module
 */

type Json = Record<string, unknown>;

type ReportCtx = {
  repoDir?: string;
};

async function swamp(
  repoDir: string | undefined,
  args: string[],
): Promise<Json> {
  const result = await new Deno.Command("swamp", {
    args,
    cwd: repoDir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  if (result.code !== 0) {
    throw new Error(`swamp ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return JSON.parse(stdout) as Json;
}

function contentOf(data: Json): Json | null {
  const content = data.content;
  return content && typeof content === "object" && !Array.isArray(content)
    ? content as Json
    : null;
}

function esc(value: unknown): string {
  return String(value ?? "").replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "_None._\n";
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n") + "\n";
}

export const report = {
  name: "@evrardjp/ssh-ca-inventory",
  description:
    "Inventory OpenSSH CA models, certificates, KRLs, and SSH config snippets",
  scope: "model" as const,
  labels: ["ssh", "openssh", "ca", "inventory"],
  execute: async (context: ReportCtx) => {
    const search = await swamp(context.repoDir, [
      "model",
      "search",
      "@evrardjp/ssh-ca",
      "--json",
    ]);
    const models = Array.isArray(search.results)
      ? search.results as Json[]
      : [];
    const inventory: Json[] = [];

    for (const model of models) {
      const name = String(model.name ?? "");
      if (!name) continue;
      let ca: Json | null = null;
      try {
        ca = contentOf(
          await swamp(context.repoDir, [
            "data",
            "get",
            name,
            "ca-current",
            "--json",
          ]),
        );
      } catch {
        ca = null;
      }
      const certRows: Json[] = [];
      const krlRows: Json[] = [];
      try {
        const listed = await swamp(context.repoDir, [
          "data",
          "query",
          `modelName == \"${name}\"`,
          "--json",
        ]);
        const results = Array.isArray(listed.results)
          ? listed.results as Json[]
          : [];
        for (const item of results) {
          const specName = item.specName ??
            (item.tags as Json | undefined)?.specName;
          const dataName = String(item.name ?? "");
          if (!dataName) continue;
          if (specName === "certificate") {
            const cert = contentOf(
              await swamp(context.repoDir, [
                "data",
                "get",
                name,
                dataName,
                "--json",
              ]),
            );
            if (cert) certRows.push({ dataName, ...cert });
          }
          if (specName === "keyrevocationlist" || specName === "revocation") {
            const krl = contentOf(
              await swamp(context.repoDir, [
                "data",
                "get",
                name,
                dataName,
                "--json",
              ]),
            );
            if (krl) krlRows.push({ dataName, ...krl });
          }
        }
      } catch {
        // Keep partial CA inventory useful even when data listing fails.
      }
      inventory.push({
        modelName: name,
        ca,
        certificates: certRows,
        krls: krlRows,
      });
    }

    const caRows = inventory.map((entry) => {
      const ca = entry.ca as Json | null;
      return [
        esc(entry.modelName),
        esc(ca?.caName),
        esc(ca?.keyAlgorithm),
        esc(ca?.publicKeyFingerprint),
        esc(ca?.publicKey),
      ];
    });

    const certRows = inventory.flatMap((entry) => {
      const certs = Array.isArray(entry.certificates)
        ? entry.certificates as Json[]
        : [];
      return certs.map((cert) => [
        esc(entry.modelName),
        esc(cert.certificateType),
        esc(cert.keyId),
        esc(cert.serial),
        esc((cert.principals as unknown[] | undefined)?.join(",")),
        esc(cert.validBefore),
        esc(cert.certificateVaultRef ? "vault" : "data"),
      ]);
    });

    const krlRows = inventory.flatMap((entry) => {
      const krls = Array.isArray(entry.krls) ? entry.krls as Json[] : [];
      return krls.map((krl) => [
        esc(entry.modelName),
        esc(krl.dataName),
        esc(krl.krlFormat),
        esc((String(krl.krlBase64 ?? "")).length),
      ]);
    });

    const config = inventory.flatMap((entry) => {
      const ca = entry.ca as Json | null;
      if (!ca?.publicKey) return [];
      return [
        `# ${entry.modelName}`,
        `# known_hosts @cert-authority example`,
        `@cert-authority *.example.local ${ca.publicKey}`,
        `# sshd_config TrustedUserCAKeys file content`,
        `${ca.publicKey}`,
        "",
      ];
    }).join("\n");

    const markdown = [
      "# OpenSSH CA Inventory",
      "",
      "## CA public keys",
      table(
        ["Model", "CA name", "Algorithm", "Fingerprint", "Public key"],
        caRows,
      ),
      "## Active/issued certificates",
      table([
        "Model",
        "Type",
        "Key ID",
        "Serial",
        "Principals",
        "Valid before",
        "Cert stored",
      ], certRows),
      "## KRL / revocation data",
      table(["Model", "Data", "Format", "Base64 bytes"], krlRows),
      "## OpenSSH configuration snippets",
      "```text",
      config.trimEnd(),
      "```",
      "",
    ].join("\n");

    return { markdown, json: { inventory } };
  },
};
