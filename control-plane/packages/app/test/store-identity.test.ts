import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const appRoot = join(import.meta.dir, "..");

describe("store identity", () => {
  test("app.json pins platform package ids", () => {
    const cfg = JSON.parse(readFileSync(join(appRoot, "app.json"), "utf8"));
    expect(cfg.ios.bundleIdentifier).toBe("sh.ompd.app");
    expect(cfg.android.package).toBe("sh.ompd.app");
    expect(cfg.macos.bundleIdentifier).toBe("sh.ompd.macos");
    expect(cfg.windows.packageName).toBe("sh.ompd.app");
  });

  test("iOS Xcode project uses sh.ompd.app", () => {
    const pbx = readFileSync(
      join(appRoot, "ios/ompd.xcodeproj/project.pbxproj"),
      "utf8",
    );
    expect(pbx).toContain("PRODUCT_BUNDLE_IDENTIFIER = sh.ompd.app;");
    expect(pbx).not.toContain("org.reactjs.native.example");
    expect(pbx).toContain("LaunchSmokeUITests.swift");
  });

  test("Android applicationId is sh.ompd.app and release is not debug-signed", () => {
    const gradle = readFileSync(join(appRoot, "android/app/build.gradle"), "utf8");
    expect(gradle).toContain('applicationId "sh.ompd.app"');
    expect(gradle).toContain('namespace "sh.ompd.app"');
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

  test("Android kotlin sources live under sh/ompd/app", () => {
    expect(existsSync(join(appRoot, "android/app/src/main/java/sh/ompd/app/MainActivity.kt"))).toBe(true);
    expect(existsSync(join(appRoot, "android/app/src/main/java/com/ompd/MainActivity.kt"))).toBe(false);
    const main = readFileSync(
      join(appRoot, "android/app/src/main/java/sh/ompd/app/MainActivity.kt"),
      "utf8",
    );
    expect(main.startsWith("package sh.ompd.app")).toBe(true);
  });

  test("native smoke tests exist for both mobile platforms", () => {
    expect(existsSync(join(appRoot, "ios/ompdUITests/LaunchSmokeUITests.swift"))).toBe(true);
    expect(existsSync(join(appRoot, "android/app/src/test/java/sh/ompd/app/PackageIdentityTest.kt"))).toBe(true);
    expect(existsSync(join(appRoot, "android/app/src/androidTest/java/sh/ompd/app/LaunchSmokeTest.kt"))).toBe(true);
  });
});
