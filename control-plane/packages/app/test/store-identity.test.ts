import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const appRoot = join(import.meta.dir, "..");

describe("store identity", () => {
  test("app.json pins platform package ids", () => {
    const cfg = JSON.parse(readFileSync(join(appRoot, "app.json"), "utf8"));
    expect(cfg.ios.bundleIdentifier).toBe("ai.ompctl.app");
    expect(cfg.android.package).toBe("ai.ompctl.app");
    expect(cfg.macos.bundleIdentifier).toBe("ai.ompctl.macos");
    expect(cfg.windows.packageName).toBe("ai.ompctl.app");
  });

  test("iOS Xcode project uses ai.ompctl.app", () => {
    const pbx = readFileSync(
      join(appRoot, "ios/ompd.xcodeproj/project.pbxproj"),
      "utf8",
    );
    expect(pbx).toContain("PRODUCT_BUNDLE_IDENTIFIER = ai.ompctl.app;");
    expect(pbx).not.toContain("org.reactjs.native.example");
    expect(pbx).toContain("LaunchSmokeUITests.swift");
  });

  test("Android applicationId is ai.ompctl.app and release is not debug-signed", () => {
    const gradle = readFileSync(join(appRoot, "android/app/build.gradle"), "utf8");
    expect(gradle).toContain('applicationId "ai.ompctl.app"');
    expect(gradle).toContain('namespace "ai.ompctl.app"');
    const buildTypesIdx = gradle.indexOf("buildTypes");
    expect(buildTypesIdx).toBeGreaterThan(0);
    const buildTypes = gradle.slice(buildTypesIdx);
    // Only the buildTypes.release block matters; signingConfigs.release also
    // contains the word "release" and must not confuse this check.
    expect(buildTypes).toMatch(/release\s*\{[\s\S]*?signingConfig signingConfigs\.release/);
    expect(buildTypes).not.toMatch(/release\s*\{[\s\S]*?signingConfig signingConfigs\.debug/);
    expect(gradle).toContain("tasks.configureEach");
    expect(gradle).toContain("debug.keystore is never used for release");
  });

  test("Android kotlin sources live under ai/ompctl/app", () => {
    expect(existsSync(join(appRoot, "android/app/src/main/java/ai/ompctl/app/MainActivity.kt"))).toBe(true);
    expect(existsSync(join(appRoot, "android/app/src/main/java/com/ompd/MainActivity.kt"))).toBe(false);
    const main = readFileSync(
      join(appRoot, "android/app/src/main/java/ai/ompctl/app/MainActivity.kt"),
      "utf8",
    );
    expect(main.startsWith("package ai.ompctl.app")).toBe(true);
  });

  test("native smoke tests exist for both mobile platforms", () => {
    expect(existsSync(join(appRoot, "ios/ompdUITests/LaunchSmokeUITests.swift"))).toBe(true);
    expect(existsSync(join(appRoot, "android/app/src/test/java/ai/ompctl/app/PackageIdentityTest.kt"))).toBe(true);
    expect(existsSync(join(appRoot, "android/app/src/androidTest/java/ai/ompctl/app/LaunchSmokeTest.kt"))).toBe(true);
  });
});
