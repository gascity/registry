import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  aggregateSources,
  checkOutputs,
  defaultOutDir,
  defaultSourcesPath,
  type IngestWarning,
  outputPaths,
  readSources,
  removeStaleOgFiles,
  renderCatalogJson,
  renderOgFiles,
  renderRegistryToml,
} from "./generate-registry.lib.ts";

type CliOptions = {
  check: boolean;
  strict: boolean;
  sources?: string;
  outDir?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { check: false, strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      options.check = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--sources") {
      options.sources = requireValue(arg, argv[++index]);
    } else if (arg.startsWith("--sources=")) {
      options.sources = requireValue(arg, arg.slice("--sources=".length));
    } else if (arg === "--out-dir") {
      options.outDir = requireValue(arg, argv[++index]);
    } else if (arg.startsWith("--out-dir=")) {
      options.outDir = requireValue(arg, arg.slice("--out-dir=".length));
    } else {
      throw new Error(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return options;
}

function requireValue(flag: string, value: string | undefined) {
  // Reject a following flag (e.g. `--out-dir --check`) being swallowed as this flag's value,
  // which would silently switch modes / write to a `./--check/` directory.
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sourcesPath = options.sources
    ? pathToFileURL(resolve(options.sources))
    : defaultSourcesPath;
  const outDir = options.outDir ? pathToFileURL(`${resolve(options.outDir)}/`) : defaultOutDir;

  if (options.check) {
    // Offline: validate the committed artifacts are self-consistent. No network, no writes.
    await checkOutputs({ sourcesPath, outDir });
    console.log("aggregate registry outputs are current");
    return;
  }

  const paths = outputPaths(outDir);
  const sources = await readSources(sourcesPath);
  const { packs, sourceSummaries, warnings } = await aggregateSources(sources, {
    onWarning: reportWarning,
  });
  const registryToml = renderRegistryToml(packs);
  const catalogJson = renderCatalogJson(packs, sourceSummaries);
  const ogFiles = renderOgFiles(packs, sourceSummaries);

  await Bun.write(paths.registry, registryToml);
  await Bun.write(paths.catalog, catalogJson);
  await mkdir(paths.ogDir, { recursive: true });
  for (const file of ogFiles) {
    await Bun.write(new URL(file.filename, paths.ogDir), file.content);
  }
  await removeStaleOgFiles(paths.ogDir, new Set(ogFiles.map((file) => file.filename)));
  console.log(`wrote ${packs.length} pack(s) from ${sources.length} source(s)`);

  await writeStepSummary(warnings);
  if (options.strict && warnings.length > 0) {
    console.error(`generate-registry: ${warnings.length} ingest warning(s) with --strict`);
    process.exitCode = 1;
  }
}

function locationOf(warning: IngestWarning) {
  return [warning.source, warning.pack, warning.release].filter(Boolean).join("/");
}

function reportWarning(warning: IngestWarning) {
  console.error(`warning: [${warning.scope}] ${locationOf(warning)}: ${warning.reason}`);
}

async function writeStepSummary(warnings: IngestWarning[]) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath || warnings.length === 0) return;
  const lines = [
    "### Registry ingest warnings",
    "",
    ...warnings.map((warning) => `- **${warning.scope}** \`${locationOf(warning)}\`: ${warning.reason}`),
    "",
  ];
  await appendFile(summaryPath, `${lines.join("\n")}\n`);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`generate-registry: ${message}`);
    process.exit(1);
  });
}
