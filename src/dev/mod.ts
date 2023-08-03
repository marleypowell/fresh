import { updateCheck } from "./update_check.ts";
import {
  DAY,
  dirname,
  emptyDir,
  exists,
  fromFileUrl,
  gte,
  join,
  posix,
  relative,
  toFileUrl,
  walk,
} from "./deps.ts";
import { error } from "./error.ts";
import {
  Manifest as ParsedManifest,
  Plugin,
  StartOptions,
} from "../server/mod.ts";
import { BUILD_ID } from "../server/build_id.ts";
import {
  getJsxSettings,
  prepareIslands,
  readDenoConfig,
} from "../server/context.ts";
import { Island } from "../server/types.ts";
import { build } from "../build/esbuild.ts";

const MIN_DENO_VERSION = "1.31.0";

export function ensureMinDenoVersion() {
  // Check that the minimum supported Deno version is being used.
  if (!gte(Deno.version.deno, MIN_DENO_VERSION)) {
    let message =
      `Deno version ${MIN_DENO_VERSION} or higher is required. Please update Deno.\n\n`;

    if (Deno.execPath().includes("homebrew")) {
      message +=
        "You seem to have installed Deno via homebrew. To update, run: `brew upgrade deno`\n";
    } else {
      message += "To update, run: `deno upgrade`\n";
    }

    error(message);
  }
}

async function collectDir(dir: string): Promise<string[]> {
  // Check if provided path is a directory
  try {
    const stat = await Deno.stat(dir);
    if (!stat.isDirectory) return [];
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }

  const paths = [];
  const fileNames = new Set<string>();
  const routesFolder = walk(dir, {
    includeDirs: false,
    includeFiles: true,
    exts: ["tsx", "jsx", "ts", "js"],
  });

  for await (const entry of routesFolder) {
    const fileNameWithoutExt = relative(dir, entry.path).split(".").slice(0, -1)
      .join(".");

    if (fileNames.has(fileNameWithoutExt)) {
      throw new Error(
        `Route conflict detected. Multiple files have the same name: ${dir}${fileNameWithoutExt}`,
      );
    }

    fileNames.add(fileNameWithoutExt);
    paths.push(relative(dir, entry.path));
  }

  paths.sort();
  return paths;
}

interface Manifest {
  routes: string[];
  islands: string[];
}

/**
 * Import specifiers must have forward slashes
 */
function toImportSpecifier(file: string) {
  let specifier = posix.normalize(file).replace(/\\/g, "/");
  if (!specifier.startsWith("..")) {
    specifier = "./" + specifier;
  }
  return specifier;
}

export async function generate(
  directory: string,
  cwd: string,
  manifest: Manifest,
) {
  const { routes, islands } = manifest;
  const rel = relative(directory, cwd);

  const output = `// DO NOT EDIT. This file is generated by Fresh.
// This file SHOULD be checked into source version control.
// This file is automatically updated during development when running \`dev.ts\`.

${
    routes.map((file, i) =>
      `import * as $${i} from "${
        toImportSpecifier(join(rel, "routes", file))
      }";`
    ).join(
      "\n",
    )
  }
${
    islands.map((file, i) =>
      `import * as $$${i} from "${
        toImportSpecifier(join(rel, "islands", file))
      }";`
    )
      .join("\n")
  }

const manifest = {
  routes: {
    ${
    routes.map((file, i) =>
      `${JSON.stringify(`${toImportSpecifier(join("routes", file))}`)}: $${i},`
    )
      .join("\n    ")
  }
  },
  islands: {
    ${
    islands.map((file, i) =>
      `${
        JSON.stringify(`${toImportSpecifier(join("islands", file))}`)
      }: $$${i},`
    )
      .join("\n    ")
  }
  },
  baseUrl: import.meta.url,
};

export default manifest;
`;

  const proc = new Deno.Command(Deno.execPath(), {
    args: ["fmt", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "null",
  }).spawn();

  const raw = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(output));
      controller.close();
    },
  });
  await raw.pipeTo(proc.stdin);
  const { stdout } = await proc.output();

  const manifestStr = new TextDecoder().decode(stdout);
  const manifestPath = join(directory, "fresh.gen.ts");

  await Deno.mkdir(dirname(manifestPath), { recursive: true });
  await Deno.writeTextFile(manifestPath, manifestStr);
  console.log(
    `%cThe manifest has been generated for ${routes.length} routes and ${islands.length} islands.`,
    "color: blue; font-weight: bold",
  );

  return manifestPath;
}

export async function dev(
  base: string,
  entrypoint: string,
  freshConfig: StartOptions,
) {
  ensureMinDenoVersion();

  // Run update check in background
  updateCheck(DAY).catch(() => {});

  entrypoint = new URL(entrypoint, base).href;

  const outDir = fromFileUrl(
    new URL(freshConfig.outDir ?? ".fresh", base).href,
  );
  const dir = dirname(fromFileUrl(base));
  const [routePaths, islandPaths] = await Promise.all([
    collectDir(join(dir, "./routes")),
    collectDir(join(dir, "./islands")),
  ]);

  let currentManifest: Manifest;
  const prevManifest = Deno.env.get("FRSH_DEV_PREVIOUS_MANIFEST");
  if (prevManifest) {
    currentManifest = JSON.parse(prevManifest);
  } else {
    currentManifest = { islands: [], routes: [] };
  }
  const newManifest = { routes: routePaths, islands: islandPaths };
  Deno.env.set("FRSH_DEV_PREVIOUS_MANIFEST", JSON.stringify(newManifest));

  const manifestChanged =
    !arraysEqual(newManifest.routes, currentManifest.routes) ||
    !arraysEqual(newManifest.islands, currentManifest.islands);

  const manifestUrl = toFileUrl(join(outDir, "fresh.gen.ts")).href;
  const hasOutDir = await exists(manifestUrl);
  if (!hasOutDir || manifestChanged) {
    await generate(outDir, dir, newManifest);
  }

  // Always clear files dir
  await emptyDir(join(outDir, "files"));

  const manifest = (await import(manifestUrl))
    .default as ParsedManifest;
  const { config, path: configPath } = await readDenoConfig(dir);

  const entrypoints = collectEntrypoints(
    true,
    prepareIslands(toFileUrl(join(dir, "islands")).href, manifest),
    freshConfig.plugins ?? [],
  );
  const snapshot = await build({
    buildID: BUILD_ID,
    entrypoints,
    configPath,
    dev: true,
    jsxConfig: getJsxSettings(config),
    outDir: join(outDir, "files"),
  });

  const dependencies = Object.fromEntries(snapshot.dependencies.entries());
  await Deno.writeTextFile(
    join(outDir, "fresh.dependencies.js"),
    `export default ${JSON.stringify(dependencies)}`,
  );

  await import(entrypoint);
}

function collectEntrypoints(
  dev: boolean,
  islands: Island[],
  plugins: Plugin[],
): Record<string, string> {
  const entrypointBase = "../runtime/entrypoints";
  const entryPoints: Record<string, string> = {
    main: dev
      ? import.meta.resolve(`${entrypointBase}/main_dev.ts`)
      : import.meta.resolve(`${entrypointBase}/main.ts`),
    deserializer: import.meta.resolve(`${entrypointBase}/deserializer.ts`),
  };

  try {
    import.meta.resolve("@preact/signals");
    entryPoints.signals = import.meta.resolve(`${entrypointBase}/signals.ts`);
  } catch {
    // @preact/signals is not in the import map
  }

  for (const island of islands) {
    entryPoints[`island-${island.id}`] = island.url;
  }

  for (const plugin of plugins) {
    for (const [name, url] of Object.entries(plugin.entrypoints ?? {})) {
      entryPoints[`plugin-${plugin.name}-${name}`] = url;
    }
  }

  return entryPoints;
}

function arraysEqual<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
