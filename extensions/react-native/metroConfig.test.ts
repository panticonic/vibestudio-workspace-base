import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BuildProviderInput } from "@vibestudio/shared/buildProvider";
import { writeProjectedMetroConfig } from "./metroConfig.js";

const temporaryRoots: string[] = [];
const require = createRequire(import.meta.url);

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("React Native provider Metro projection", () => {
  it("uses only source and dependency paths supplied by Build V2", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rn-metro-projection-"));
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "source", "apps", "mobile");
    const outputPath = path.join(root, "output");
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.mkdirSync(outputPath, { recursive: true });
    fs.writeFileSync(
      path.join(sourcePath, "native-module-policy.json"),
      JSON.stringify({
        blockedImports: {
          "react-native-keychain": ["src/services/pushNotifications.ts"],
        },
      })
    );
    const input: BuildProviderInput = {
      target: "react-native",
      unitName: "@workspace-apps/mobile",
      sourcePath,
      dependencyProjection: {
        nodeModulesPath: path.resolve("node_modules"),
        modules: {
          "@workspace-apps/mobile": sourcePath,
          "@vibestudio/mobile-webrtc": path.resolve("packages/mobile-webrtc"),
        },
      },
      effectiveVersion: "ev-test",
      manifest: {
        app: {
          target: "react-native",
          renderer: "App.tsx",
          nativeModulePolicy: "native-module-policy.json",
        },
      },
    };

    const configPath = writeProjectedMetroConfig(input, outputPath);
    const config = fs.readFileSync(configPath, "utf8");

    expect(config).toContain(JSON.stringify(sourcePath));
    expect(config).toContain(JSON.stringify(path.resolve("node_modules")));
    expect(config).toContain(require.resolve("@react-native/metro-config"));
    expect(config).toContain(JSON.stringify(path.resolve("packages/mobile-webrtc")));
    expect(config).toContain("react-native-keychain");
    expect(config).not.toContain("process.cwd");
    expect(config).not.toContain("VIBESTUDIO_REPO_ROOT");
    expect(config).not.toContain("workspaceRoot");
    expect(config).not.toContain("apps/mobile/metro.config.js");
    const loaded = require(configPath) as {
      resolver: {
        nodeModulesPaths: string[];
        extraNodeModules: Record<string, string>;
      };
    };
    expect(loaded.resolver.nodeModulesPaths).toEqual([
      path.resolve("node_modules"),
      path.resolve(require.resolve("@react-native/metro-config/package.json"), "..", "..", ".."),
    ]);
    expect(loaded.resolver.extraNodeModules["@workspace-apps/mobile"]).toBe(sourcePath);
    expect(config).not.toContain("packageExportTarget");
  });

  it("lets Metro resolve exact projected package subpath exports", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rn-metro-exports-"));
    temporaryRoots.push(root);
    const sourcePath = path.join(root, "apps", "mobile");
    const runtimePath = path.join(root, "packages", "runtime");
    const outputPath = path.join(root, "output");
    fs.mkdirSync(sourcePath, { recursive: true });
    fs.mkdirSync(path.join(runtimePath, "src", "shared"), { recursive: true });
    fs.mkdirSync(outputPath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, "native-module-policy.json"), '{"blockedImports":{}}');
    fs.writeFileSync(
      path.join(runtimePath, "package.json"),
      JSON.stringify({
        name: "@workspace/runtime",
        exports: { "./workspace-presentation": "./src/shared/workspacePresentation.ts" },
      })
    );
    fs.writeFileSync(
      path.join(runtimePath, "src", "shared", "workspacePresentation.ts"),
      "export const presentation = true;\n"
    );
    const configPath = writeProjectedMetroConfig(
      {
        target: "react-native",
        unitName: "@workspace-apps/mobile",
        sourcePath,
        dependencyProjection: {
          nodeModulesPath: path.resolve("node_modules"),
          modules: { "@workspace/runtime": runtimePath },
        },
        effectiveVersion: "ev-test",
        manifest: { app: { nativeModulePolicy: "native-module-policy.json" } },
      },
      outputPath
    );
    const config = require(configPath) as {
      resolver: {
        resolveRequest(
          context: { originModulePath: string; resolveRequest: (...args: unknown[]) => unknown },
          moduleName: string,
          platform: string
        ): unknown;
      };
    };
    const resolveRequest = vi.fn((_context, target) => target);

    expect(
      config.resolver.resolveRequest(
        { originModulePath: path.join(sourcePath, "App.tsx"), resolveRequest },
        "@workspace/runtime/workspace-presentation",
        "android"
      )
    ).toBe("@workspace/runtime/workspace-presentation");
    expect(resolveRequest).toHaveBeenCalledWith(
      expect.any(Object),
      "@workspace/runtime/workspace-presentation",
      "android"
    );
  });
});
