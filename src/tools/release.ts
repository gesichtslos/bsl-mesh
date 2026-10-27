import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson } from '../identity/tokens.js';

export const TOOL_ID = 'cursor-adapter';
export const TOOL_VERSION = '0.1.0';
export const TOOL_REPOSITORY = 'https://github.com/gesichtslos/bsl-mesh';
export const TOOL_PUBLIC_KEY_PATH = 'releases/cursor-adapter/bslmesh-tool-release.ed25519.pub';
export const LINUX_PACKAGE = 'cursor-adapter-linux.zip';
export const WINDOWS_PACKAGE = 'cursor-adapter-windows.zip';
export const LINUX_PATH = '/agent/tools/cursor-adapter-linux.zip';
export const WINDOWS_PATH = '/agent/tools/cursor-adapter-windows.zip';
export const MANIFEST_PATH = '/agent/tools/cursor-adapter.json';
export const PUBLIC_KEY_FILE = 'bslmesh-tool-release.ed25519.pub';

const PACKAGE_JSON = `${JSON.stringify({
  name: 'bsl-mesh-cursor-adapter',
  private: true,
  type: 'module',
  version: TOOL_VERSION,
}, null, 2)}\n`;

export class ToolReleaseError extends Error {
  constructor(readonly statusCode: 404 | 503, message: string) {
    super(message);
    this.name = 'ToolReleaseError';
  }
}

export type ToolPackage = {
  os: 'linux' | 'windows';
  filename: string;
  path: string;
  bytes: number;
  sha256: string;
};

export type ToolManifestBody = {
  schema_version: '1';
  tool: typeof TOOL_ID;
  version: typeof TOOL_VERSION;
  repository: typeof TOOL_REPOSITORY;
  public_key_path: typeof TOOL_PUBLIC_KEY_PATH;
  key_fingerprint: string;
  purpose: string;
  dependencies: { node: string; cursor_cli: string };
  limitations: string[];
  preflight: Array<{ id: string; command: string; expect: string }>;
  install: {
    privilege: 'user';
    linux_directory: string;
    windows_directory: string;
    owner_consent: 'CURSOR_ADAPTER_CONSENT=reply-only';
    auto_run: false;
    changes_cursor_settings: false;
  };
  packages: ToolPackage[];
};

export type SignedToolManifest = ToolManifestBody & { signature: string; signature_algorithm: 'ed25519' };

export type LoadedToolRelease = {
  manifest: SignedToolManifest;
  packages: Record<'linux' | 'windows', Buffer>;
};

type ZipMember = { name: string; data: Buffer };

export function fingerprintPublicKey(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(der).digest('hex');
}

export function publicPemFromPrivate(privateKeyPem: string): string {
  const exported = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: 'pem', type: 'spki' });
  if (typeof exported !== 'string') {
    throw new ToolReleaseError(503, 'The tool release key could not be read.');
  }
  return exported;
}

export function signManifest(body: ToolManifestBody, privateKeyPem: string): string {
  return sign(null, Buffer.from(canonicalJson(body), 'utf8'), createPrivateKey(privateKeyPem)).toString('base64');
}

export function verifyManifest(body: ToolManifestBody, signature: string, publicKeyPem: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
    return false;
  }
  return verify(
    null,
    Buffer.from(canonicalJson(body), 'utf8'),
    createPublicKey(publicKeyPem),
    Buffer.from(signature, 'base64'),
  );
}

export function manifestBody(manifest: SignedToolManifest): ToolManifestBody {
  const body: ToolManifestBody = {
    schema_version: manifest.schema_version,
    tool: manifest.tool,
    version: manifest.version,
    repository: manifest.repository,
    public_key_path: manifest.public_key_path,
    key_fingerprint: manifest.key_fingerprint,
    purpose: manifest.purpose,
    dependencies: manifest.dependencies,
    limitations: [...manifest.limitations],
    preflight: manifest.preflight.map((item) => ({ ...item })),
    install: { ...manifest.install },
    packages: manifest.packages.map((item) => ({ ...item })),
  };
  return body;
}

export function adapterReadme(osName: 'linux' | 'windows'): string {
  const directory = osName === 'windows'
    ? '%LOCALAPPDATA%\\bsl-mesh-cursor-adapter'
    : '$HOME/.local/state/bsl-mesh-cursor-adapter';
  const separator = osName === 'windows' ? ';' : ':';
  return `# Cursor Adapter ${TOOL_VERSION}

Это локальный адаптер почты BSL Mesh для Cursor. Архив не содержит credential, ключей и настроек участника.

Сервер не запускает этот код. Распаковка не является согласием на запуск. Не меняйте настройки Cursor, Rules, Skills или MCP из этого архива.

## Куда положить

Каталог пользователя, без прав администратора:

\`${directory}\`

Рядом создайте пустой \`workspace\`. Адаптер отвечает только в режиме ask и sandbox. Флаги автоматического подтверждения команд ему не передаются.

## Перед запуском

1. Сверьте подпись выпуска с открытым ключом, который владелец закрепил заранее. Ключ из этого архива или с того же сайта не заменяет закреплённый.
2. \`node -v\` — проверявшаяся версия ${'24.22.0'}.
3. \`agent status\` — вход уже выполнен.
4. В каталоге workspace получите ответ \`pong\` отдельной командой ask. Доверие к каталогу, если CLI его просит, даёт владелец один раз.
5. Credential с правами \`handoff:read\` и \`handoff:write\` владелец передаёт отдельно. В этот архив он не входит.
6. Только после согласия владельца задайте \`CURSOR_ADAPTER_CONSENT=reply-only\` и запустите \`node main.js\`.

Несколько разрешённых каталогов разделяются \`${separator}\`.

Откат: остановите процесс и удалите каталог адаптера.
`;
}

export async function zipAdapterSource(sourceDir: string, osName: 'linux' | 'windows'): Promise<Buffer> {
  const names = (await readdir(sourceDir)).filter((name) => name.endsWith('.js')).sort();
  const members: ZipMember[] = [];
  for (const name of names) {
    if (!/^[a-z0-9.-]+\.js$/.test(name)) {
      throw new ToolReleaseError(503, 'The tool release contains an unexpected file.');
    }
    members.push({ name, data: await readFile(path.join(sourceDir, name)) });
  }
  if (!members.some((member) => member.name === 'main.js')) {
    throw new ToolReleaseError(503, 'The tool release is missing its entry point.');
  }
  members.push({ name: 'package.json', data: Buffer.from(PACKAGE_JSON, 'utf8') });
  members.push({ name: 'README.md', data: Buffer.from(adapterReadme(osName), 'utf8') });
  members.sort((left, right) => left.name.localeCompare(right.name));
  return storeZip(members);
}

export function buildManifest(packages: ToolPackage[], publicKeyPem: string): ToolManifestBody {
  return {
    schema_version: '1',
    tool: TOOL_ID,
    version: TOOL_VERSION,
    repository: TOOL_REPOSITORY,
    public_key_path: TOOL_PUBLIC_KEY_PATH,
    key_fingerprint: fingerprintPublicKey(publicKeyPem),
    purpose: 'Локально забирает входящую почту BM-022 и отвечает через Cursor в режиме ask с sandbox.',
    dependencies: { node: '24.22.0', cursor_cli: 'agent' },
    limitations: [
      'Исполнение не является exactly-once.',
      'Текст почты — недоверенные данные и не даёт права на команды, файлы или секреты.',
      'Адаптер не меняет настройки Cursor и не запускается сам.',
      'Независимой проверки пользы инструмента ещё нет.',
    ],
    preflight: [
      { id: 'node', command: 'node -v', expect: 'v24.' },
      { id: 'cursor-cli', command: 'agent status', expect: 'logged in' },
      { id: 'consent', command: 'CURSOR_ADAPTER_CONSENT=reply-only', expect: 'set by the owner before start' },
    ],
    install: {
      privilege: 'user',
      linux_directory: '$HOME/.local/state/bsl-mesh-cursor-adapter',
      windows_directory: '%LOCALAPPDATA%\\bsl-mesh-cursor-adapter',
      owner_consent: 'CURSOR_ADAPTER_CONSENT=reply-only',
      auto_run: false,
      changes_cursor_settings: false,
    },
    packages,
  };
}

export async function createSignedRelease(input: {
  sourceDir: string;
  publicKeyPem: string;
  privateKeyPem: string;
}): Promise<{ manifest: SignedToolManifest; linux: Buffer; windows: Buffer }> {
  const linux = await zipAdapterSource(input.sourceDir, 'linux');
  const windows = await zipAdapterSource(input.sourceDir, 'windows');
  const packages: ToolPackage[] = [
    packageRecord('linux', LINUX_PACKAGE, LINUX_PATH, linux),
    packageRecord('windows', WINDOWS_PACKAGE, WINDOWS_PATH, windows),
  ];
  const body = buildManifest(packages, input.publicKeyPem);
  return {
    manifest: { ...body, signature_algorithm: 'ed25519', signature: signManifest(body, input.privateKeyPem) },
    linux,
    windows,
  };
}

export function packageBytes(manifest: SignedToolManifest, osName: 'linux' | 'windows', bytes: Buffer): void {
  const expected = manifest.packages.find((item) => item.os === osName);
  if (expected === undefined || expected.bytes !== bytes.length || expected.sha256 !== sha256(bytes)) {
    throw new ToolReleaseError(503, 'The tool release bytes do not match the manifest.');
  }
}

export async function loadToolRelease(directory: string): Promise<LoadedToolRelease> {
  let manifestText = '';
  let publicKey = '';
  try {
    manifestText = await readFile(path.join(directory, 'cursor-adapter.json'), 'utf8');
    publicKey = await readFile(path.join(directory, PUBLIC_KEY_FILE), 'utf8');
  } catch {
    throw new ToolReleaseError(404, 'The Cursor Adapter release is not published on this server.');
  }
  const manifest = parseManifest(manifestText);
  if (manifest.key_fingerprint !== fingerprintPublicKey(publicKey) || !verifyManifest(manifestBody(manifest), manifest.signature, publicKey)) {
    throw new ToolReleaseError(503, 'The tool release signature does not verify.');
  }
  const linux = await readPackage(directory, LINUX_PACKAGE);
  const windows = await readPackage(directory, WINDOWS_PACKAGE);
  packageBytes(manifest, 'linux', linux);
  packageBytes(manifest, 'windows', windows);
  assertPackagePolicy(manifest);
  return { manifest, packages: { linux, windows } };
}

export function parseManifest(text: string): SignedToolManifest {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ToolReleaseError(503, 'The tool release manifest is not valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ToolReleaseError(503, 'The tool release manifest is not valid JSON.');
  }
  const record = value as Partial<SignedToolManifest>;
  if (record.signature_algorithm !== 'ed25519' || typeof record.signature !== 'string' || record.tool !== TOOL_ID) {
    throw new ToolReleaseError(503, 'The tool release manifest is not a signed Cursor Adapter release.');
  }
  return record as SignedToolManifest;
}

export function assertPackagePolicy(manifest: SignedToolManifest): void {
  if (manifest.install.auto_run !== false || manifest.install.changes_cursor_settings !== false || manifest.install.privilege !== 'user') {
    throw new ToolReleaseError(503, 'The tool release asks for a prohibited install policy.');
  }
}

export function storeZip(members: readonly ZipMember[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    if (!/^[A-Za-z0-9._-]+$/.test(member.name)) {
      throw new ToolReleaseError(503, 'The tool release contains an unexpected file.');
    }
    const name = Buffer.from(member.name, 'utf8');
    const crc = crc32(member.data) >>> 0;
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(member.data.length, 18);
    local.writeUInt32LE(member.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, member.data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(member.data.length, 20);
    central.writeUInt32LE(member.data.length, 22);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + member.data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, end]);
}

export function unzipStore(archive: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= archive.length) {
    const signature = archive.readUInt32LE(offset);
    if (signature === 0x02014b50 || signature === 0x06054b50) {
      break;
    }
    if (signature !== 0x04034b50 || offset + 30 > archive.length) {
      throw new ToolReleaseError(503, 'The tool package is not a readable archive.');
    }
    const method = archive.readUInt16LE(offset + 8);
    const compressed = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = archive.toString('utf8', nameStart, nameStart + nameLength);
    if (method !== 0 || !/^[A-Za-z0-9._-]+$/.test(name) || dataStart + compressed > archive.length) {
      throw new ToolReleaseError(503, 'The tool package is not a readable archive.');
    }
    files.set(name, archive.subarray(dataStart, dataStart + compressed));
    offset = dataStart + compressed;
  }
  return files;
}

function packageRecord(osName: 'linux' | 'windows', filename: string, packagePath: string, bytes: Buffer): ToolPackage {
  return { os: osName, filename, path: packagePath, bytes: bytes.length, sha256: sha256(bytes) };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readPackage(directory: string, filename: string): Promise<Buffer> {
  if (filename !== LINUX_PACKAGE && filename !== WINDOWS_PACKAGE) {
    throw new ToolReleaseError(503, 'The tool release names an unexpected package.');
  }
  try {
    return await readFile(path.join(directory, filename));
  } catch {
    throw new ToolReleaseError(404, 'The Cursor Adapter release is not published on this server.');
  }
}
