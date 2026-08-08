import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const outputDirectory = path.join(projectRoot, 'dist');

if (!existsSync(path.join(projectRoot, 'package.json')) || path.basename(outputDirectory) !== 'dist') {
  throw new Error(`빌드 출력 경로를 확인할 수 없습니다: ${outputDirectory}`);
}

rmSync(outputDirectory, { recursive: true, force: true });
