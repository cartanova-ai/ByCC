/**
 * AI SDK + CLI 패키지를 npm에 퍼블리시하는 스크립트.
 * 각 패키지의 버전이 npm에 이미 존재하면 스킵.
 */
import { exec } from "child_process";
import { readFile } from "fs/promises";
import { resolve } from "path";

type PackageInfo = { name: string; version: string };

async function getPackageInfo(packagePath: string): Promise<PackageInfo> {
  const raw = await readFile(resolve(packagePath, "package.json"), "utf-8");
  const { name, version } = JSON.parse(raw);
  return { name, version };
}

async function isPublished(pkg: PackageInfo): Promise<boolean> {
  const res = await fetch(`https://registry.npmjs.org/${pkg.name}`);
  if (!res.ok) return false;
  const data = await res.json();
  return Object.keys(data.versions).includes(pkg.version);
}

async function publishPackage(pkg: PackageInfo): Promise<void> {
  return new Promise((res, rej) => {
    console.log(`${pkg.name}@${pkg.version}: publishing...`);
    const child = exec(
      `mise exec -- pnpm --filter ${pkg.name} publish --no-git-checks --access public`,
    );
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    child.on("close", (code) => {
      if (code === 0) {
        console.log(`✓ ${pkg.name}@${pkg.version} published`);
        res();
      } else {
        rej(new Error(`${pkg.name} publish failed (exit ${code})`));
      }
    });
  });
}

async function main() {
  const paths = ["./packages/ai-sdk", "./packages/cli"];

  for (const path of paths) {
    const pkg = await getPackageInfo(path);
    if (await isPublished(pkg)) {
      console.log(`${pkg.name}@${pkg.version}: already published, skipping`);
    } else {
      await publishPackage(pkg);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
