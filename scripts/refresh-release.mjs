// Use only for an exact source rollback/rebuild: invalidate Docker's COPY cache safely.
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
await writeFile(new URL('../deployment-version.txt', import.meta.url), `${new Date().toISOString()}-${randomUUID()}\n`);
console.log('已更新 deployment-version.txt。将它与回退代码一起提交并 push；本命令不会部署或读取密钥。');
