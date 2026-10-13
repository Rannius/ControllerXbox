"""Validate this repository's deliberately fixed self-hosted job routing."""
from pathlib import Path
import re

EXPECTED = '[self-hosted, Linux, X64, rannius-linux, project-controllerxbox]'
jobs = 0
for path in sorted(Path('.github/workflows').glob('*')):
    if path.suffix not in ('.yml', '.yaml'):
        continue
    lines = path.read_text(encoding='utf-8-sig').splitlines()
    in_jobs = False
    job_names = []
    routes = []
    for line in lines:
        if line and not line.startswith((' ', '#')):
            in_jobs = line == 'jobs:'
        if not in_jobs or not line.strip() or line.lstrip().startswith('#'):
            continue
        if re.fullmatch(r'  [A-Za-z0-9_-]+:', line):
            job_names.append(line.strip()[:-1])
        if re.match(r'    runs-on:', line):
            if line.strip() != 'runs-on: ' + EXPECTED:
                raise SystemExit(f'{path}: runner selection differs from the approved self-hosted pool')
            routes.append(line)
        if re.match(r'    uses:', line):
            raise SystemExit(f'{path}: remote reusable workflow needs separate runner review')
    if not job_names or len(job_names) != len(routes):
        raise SystemExit(f'{path}: every job must declare one fixed self-hosted runner selector')
    jobs += len(routes)
print(f'SELF_HOSTED_POLICY_OK jobs={jobs}')
