"""Reproducible source distribution; excludes dependencies, runtime state and secrets."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import shutil
import os

root = Path(__file__).resolve().parents[1]
output = root / 'artifacts/mobile-anonymous-chat-v1.zip'
output.parent.mkdir(exist_ok=True)
excluded = {'node_modules', '.git', '.omx', '.codex', '.wrangler', 'dist', 'artifacts', '__pycache__', '.data', '.cloudbase', '.tcb', '.cache', 'coverage'}
allowed = {'apps', 'packages', 'scripts', 'tests', 'docs'}
with ZipFile(output, 'w', ZIP_DEFLATED) as archive:
    for directory, dirs, files in os.walk(root):
        rel_dir = Path(directory).relative_to(root)
        dirs[:] = sorted(d for d in dirs if d not in excluded and (rel_dir.parts or d in allowed))
        for name in sorted(files):
            path = Path(directory) / name
            rel = path.relative_to(root)
            if name in {'source.zip', 'AGENTS.md'} or (name.startswith(('.env', '.dev.vars')) and name != '.env.example') or path.suffix in {'.log', '.pem', '.key'}:
                continue
            archive.write(path, str(Path('mobile-anonymous-chat-v1') / rel))
public = root / 'apps/web/public/source.zip'
public.parent.mkdir(parents=True, exist_ok=True)
shutil.copyfile(output, public)
print(f'Source ZIP: {output} ({output.stat().st_size} bytes)')
