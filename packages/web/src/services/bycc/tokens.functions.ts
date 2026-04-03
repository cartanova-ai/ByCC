/**
 * @generated
 * API에서 동기화된 파일입니다. 직접 수정하지 마세요.
 */
/**
 * 토큰 파일 관리 — <project-root>/data/bycc-tokens.json
 *
 * 프로젝트 루트의 data/ 디렉터리에 저장.
 * 디렉터리 0o700, 파일 0o600 퍼미션으로 토큰 보안.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const TokenEntry = z.object({
  token: z.string(),
  name: z.string().optional(),
  active: z.boolean().default(true),
  addedAt: z.string(),
});
export type TokenEntry = z.infer<typeof TokenEntry>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "../../../../..");
const DEFAULT_DIR = process.env.BYCC_TOKEN_DIR ?? join(PROJECT_ROOT, "data");
const DEFAULT_FILE = "bycc-tokens.json";

function ensureDir(dir: string): void {
  if (existsSync(dir)) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory()) {
      throw new Error(`${dir} exists but is not a directory (possible symlink attack)`);
    }
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function getTokenFilePath(dir?: string): string {
  return join(dir ?? DEFAULT_DIR, DEFAULT_FILE);
}

export function loadTokens(dir?: string): TokenEntry[] {
  const tokenDir = dir ?? DEFAULT_DIR;
  const filePath = getTokenFilePath(tokenDir);

  if (!existsSync(filePath)) return [];

  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  return z.array(TokenEntry).parse(parsed);
}

export function saveTokens(entries: TokenEntry[], dir?: string): void {
  const tokenDir = dir ?? DEFAULT_DIR;
  ensureDir(tokenDir);

  const filePath = getTokenFilePath(tokenDir);
  writeFileSync(filePath, JSON.stringify(entries, null, 2), {
    mode: 0o600,
  });
  chmodSync(filePath, 0o600);
}

export function addTokenToFile(token: string, name?: string, dir?: string): TokenEntry {
  const entries = loadTokens(dir);
  const existing = entries.find((e) => e.token === token);
  if (existing) return existing;

  const entry: TokenEntry = {
    token,
    name,
    active: true,
    addedAt: new Date().toISOString(),
  };
  entries.push(entry);
  saveTokens(entries, dir);
  return entry;
}

export function updateTokenInFile(
  token: string,
  updates: { name?: string; token?: string },
  dir?: string,
): TokenEntry | null {
  const entries = loadTokens(dir);
  const entry = entries.find((e) => e.token === token);
  if (!entry) return null;

  if (updates.name !== undefined) entry.name = updates.name;
  if (updates.token !== undefined) entry.token = updates.token;

  saveTokens(entries, dir);
  return entry;
}

export function removeTokenFromFile(token: string, dir?: string): boolean {
  const entries = loadTokens(dir);
  const filtered = entries.filter((e) => e.token !== token);
  if (filtered.length === entries.length) return false;

  saveTokens(filtered, dir);
  return true;
}
