import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { BuildProviderInput } from "@vibestudio/shared/buildProvider";

interface NativeModulePolicy {
  blockedImports: Record<string, string[]>;
}

export function writeProjectedMetroConfig(input: BuildProviderInput, tempDir: string): string {
  const nodeModulesPath = input.dependencyProjection.nodeModulesPath;
  if (!nodeModulesPath) {
    throw new Error("React Native builds require a Build V2 dependency projection");
  }
  const app = appManifest(input);
  const policy = readNativeModulePolicy(input.sourcePath, app["nativeModulePolicy"]);
  // Metro is the build provider's tool, not an application runtime dependency.
  // Resolve it from this extension's exact dependency environment so a mobile
  // app does not have to duplicate the provider's implementation dependency.
  const providerRequire = createRequire(import.meta.url);
  const metroConfigPackage = providerRequire.resolve("@react-native/metro-config");
  const providerNodeModulesPath = path.resolve(
    path.dirname(providerRequire.resolve("@react-native/metro-config/package.json")),
    "..",
    ".."
  );
  const babelTransformerPath = writeBabelTransformer({
    tempDir,
    nodeModulesPath,
    providerRequire,
  });
  const configPath = path.join(tempDir, "metro.config.cjs");
  const data = JSON.stringify({
    sourcePath: input.sourcePath,
    nodeModulesPath,
    modules: input.dependencyProjection.modules,
    policy,
    metroConfigPackage,
    providerNodeModulesPath,
    babelTransformerPath,
  });
  fs.writeFileSync(configPath, metroConfigSource(data));
  return configPath;
}

function tryResolve(resolve: (specifier: string) => string, specifier: string): string | null {
  try {
    return resolve(specifier);
  } catch {
    return null;
  }
}

/**
 * Give Metro the Babel plugins a React Native app cannot express itself.
 *
 * Babel discovers `babel.config.js` from the project root and resolves plugin
 * names from there, but a built workspace app is a bare content-addressed
 * source tree with no `node_modules` beside it — so an app-authored config
 * could name no plugin that would actually resolve. The provider owns the
 * toolchain, so it supplies them, already resolved to absolute paths.
 *
 * Both are load-bearing rather than optional polish, and both fail in a way
 * that hides the cause: Metro's first-require guard swallows a module factory
 * throw and hands the importer `undefined`, so the visible symptom is a
 * `Cannot read property 'X' of undefined` somewhere downstream.
 *  - Reanimated's plugin compiles worklets. Without it every worklet throws
 *    the moment a library touching Reanimated is required.
 *  - `export-namespace-from` is not in @react-native/babel-preset, and any
 *    `export * as ns from "..."` silently becomes an undefined namespace.
 */
function writeBabelTransformer(input: {
  tempDir: string;
  nodeModulesPath: string;
  providerRequire: NodeJS.Require;
}): string {
  const upstream = input.providerRequire.resolve("@react-native/metro-babel-transformer");
  // Reanimated's plugin is versioned with the app's Reanimated, so it comes
  // from the app's dependency projection; apps without it simply get no plugin.
  const reanimated = tryResolve(
    (specifier) => input.providerRequire.resolve(specifier, { paths: [input.nodeModulesPath] }),
    "react-native-reanimated/plugin"
  );
  const exportNamespace = input.providerRequire.resolve(
    "@babel/plugin-transform-export-namespace-from"
  );
  const transformerPath = path.join(input.tempDir, "babel-transformer.cjs");
  fs.writeFileSync(
    transformerPath,
    `
const upstream = require(${JSON.stringify(upstream)});
const injected = ${JSON.stringify([exportNamespace, ...(reanimated ? [reanimated] : [])])};

module.exports = {
  ...upstream,
  // Metro keys its transform cache on this. Upstream's key knows nothing about
  // the plugins injected below, so without mixing them in a bundle built before
  // this provider learned to inject them would be served from cache unchanged —
  // the untransformed output whose failure this whole shim exists to prevent.
  getCacheKey() {
    const upstreamKey = upstream.getCacheKey ? upstream.getCacheKey() : "";
    return require("node:crypto")
      .createHash("sha256")
      .update(upstreamKey)
      .update("\\u0000vibestudio-injected-babel-plugins\\u0000")
      .update(injected.join("\\u0000"))
      .digest("hex");
  },
  transform(args) {
    // Reanimated's plugin must stay last: it rewrites worklets and expects to
    // see the output of every other transform.
    return upstream.transform({ ...args, plugins: [...(args.plugins ?? []), ...injected] });
  },
};
`
  );
  return transformerPath;
}

function appManifest(input: BuildProviderInput): Record<string, unknown> {
  return input.manifest["app"] && typeof input.manifest["app"] === "object"
    ? (input.manifest["app"] as Record<string, unknown>)
    : input.manifest;
}

function readNativeModulePolicy(sourcePath: string, declaration: unknown): NativeModulePolicy {
  if (typeof declaration !== "string" || declaration.length === 0) {
    return { blockedImports: {} };
  }
  const appRoot = path.resolve(sourcePath);
  const policyPath = path.resolve(appRoot, declaration);
  if (!policyPath.startsWith(`${appRoot}${path.sep}`)) {
    throw new Error("React Native nativeModulePolicy escapes the app source");
  }
  const parsed = JSON.parse(fs.readFileSync(policyPath, "utf8")) as Partial<NativeModulePolicy>;
  if (!parsed.blockedImports || typeof parsed.blockedImports !== "object") {
    throw new Error("React Native nativeModulePolicy must declare blockedImports");
  }
  for (const [moduleName, importers] of Object.entries(parsed.blockedImports)) {
    if (
      !moduleName ||
      !Array.isArray(importers) ||
      importers.some((item) => typeof item !== "string")
    ) {
      throw new Error("React Native nativeModulePolicy contains an invalid blocked import");
    }
  }
  return { blockedImports: parsed.blockedImports };
}

function metroConfigSource(data: string): string {
  return `
const fs = require("node:fs");
const path = require("node:path");
const data = ${data};
const { getDefaultConfig, mergeConfig } = require(data.metroConfigPackage);
const normalize = (value) => path.resolve(value).replace(/\\\\/g, "/");
const allowedByModule = new Map(
  Object.entries(data.policy.blockedImports).map(([moduleName, importers]) => [
    moduleName,
    new Set(importers.map((importer) => normalize(path.join(data.sourcePath, importer)))),
  ]),
);
const mobileWebRtc = data.modules["@vibestudio/mobile-webrtc"];
if (mobileWebRtc) {
  allowedByModule.get("react-native-keychain")?.add(normalize(path.join(mobileWebRtc, "src/connect.ts")));
  allowedByModule.get("@react-native-async-storage/async-storage")?.add(
    normalize(path.join(mobileWebRtc, "src/connect.ts")),
  );
  allowedByModule.get("@react-native-async-storage/async-storage")?.add(
    normalize(path.join(mobileWebRtc, "src/connectLink.ts")),
  );
}
const blockedImportFor = (moduleName) =>
  Object.keys(data.policy.blockedImports).find(
    (blocked) => moduleName === blocked || moduleName.startsWith(blocked + "/"),
  );
const guardNativeImport = (moduleName, originModulePath) => {
  const blocked = blockedImportFor(moduleName);
  if (!blocked) return;
  const origin = originModulePath ? normalize(originModulePath) : "";
  if (allowedByModule.get(blocked)?.has(origin)) return;
  throw new Error(
    'Direct import of native module "' + moduleName + '" from workspace app code is blocked. ' +
      'Importer: ' + (origin || "unknown") + '. Use the Vibestudio platform-owned wrapper for this native surface.',
  );
};
const polyfills = {
  path: require.resolve("path-browserify", { paths: [data.nodeModulesPath] }),
  crypto: path.join(data.sourcePath, "src/polyfills/crypto.js"),
  fs: path.join(data.sourcePath, "src/polyfills/fs.js"),
  "node:crypto": path.join(data.sourcePath, "src/polyfills/crypto.js"),
  "node:path": require.resolve("path-browserify", { paths: [data.nodeModulesPath] }),
  "node:fs": path.join(data.sourcePath, "src/polyfills/fs.js"),
};
const config = {
  transformer: {
    babelTransformerPath: data.babelTransformerPath,
  },
  watchFolders: [...new Set([
    data.sourcePath,
    data.nodeModulesPath,
    data.providerNodeModulesPath,
    ...Object.values(data.modules),
  ])].filter((candidate) => fs.existsSync(candidate)),
  resolver: {
    // Application dependencies remain authoritative. Metro's own dependency
    // closure is a fallback only for build-tool runtime modules.
    nodeModulesPaths: [data.nodeModulesPath, data.providerNodeModulesPath],
    extraNodeModules: data.modules,
    resolveRequest(context, moduleName, platform) {
      guardNativeImport(moduleName, context.originModulePath);
      if (polyfills[moduleName]) return { type: "sourceFile", filePath: polyfills[moduleName] };
      if (
        moduleName === "react" ||
        moduleName === "react/jsx-runtime" ||
        moduleName === "react/jsx-dev-runtime" ||
        moduleName === "react-native-webrtc" ||
        moduleName.startsWith("react-native-webrtc/")
      ) {
        return context.resolveRequest(
          context,
          path.join(data.nodeModulesPath, ...moduleName.split("/")),
          platform,
        );
      }
      if (moduleName === "react-native-screens") {
        return {
          type: "sourceFile",
          filePath: path.join(
            data.nodeModulesPath,
            "react-native-screens/lib/commonjs/index.js",
          ),
        };
      }
      if (
        moduleName.endsWith(".js") &&
        (moduleName.startsWith("./") || moduleName.startsWith("../") || moduleName.startsWith("/"))
      ) {
        try {
          return context.resolveRequest(context, moduleName.slice(0, -3), platform);
        } catch {}
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};
module.exports = mergeConfig(getDefaultConfig(data.sourcePath), config);
`;
}
