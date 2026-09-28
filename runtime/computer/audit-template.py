#!/usr/bin/env python3
"""Audit actual requested tool availability in a locked-down prepared E2B VM."""

import argparse
import hashlib
import json
import pathlib

from e2b import Sandbox


MODULE_OVERRIDES = {
    'beautifulsoup4': ['bs4'], 'dbus-python': ['dbus'], 'fonttools': ['fontTools'], 'GitPython': ['git'],
    'ipython': ['IPython'], 'markdown-it-py': ['markdown_it'], 'pillow': ['PIL'],
    'protobuf': ['google.protobuf'], 'PyGObject': ['gi'], 'PyJWT': ['jwt'],
    'python-apt': ['apt', 'apt_pkg'], 'python-dateutil': ['dateutil'],
    'PyYAML': ['yaml'], 'pyzmq': ['zmq'], 'scikit-learn': ['sklearn'],
}


PROBE = r'''import importlib, importlib.metadata, json, os, pathlib, socket, subprocess, sys
requested = json.loads(pathlib.Path('/tmp/requested-inventory.json').read_text())
marker = json.loads(pathlib.Path('/opt/computer-use/image.json').read_text())
packages = {}
for distribution in importlib.metadata.distributions():
    packages.setdefault(distribution.metadata['Name'].lower().replace('_', '-'), distribution.version)
apt_names = marker['apt_packages'] + marker.get('expanded_profile', {}).get('apt_packages', [])
apt_versions = subprocess.run(['dpkg-query', '-W', '-f=${Package}\t${Version}\n', *apt_names], capture_output=True, text=True)
freeze = subprocess.run(['/opt/opulent-tools/venv/bin/python', '-m', 'pip', 'freeze'], capture_output=True, text=True)
cli_freeze = subprocess.run(['/opt/opulent-tools/cli-venv/bin/python', '-m', 'pip', 'freeze'], capture_output=True, text=True)
python = {}
for name, version in requested['python'].items():
    actual = packages.get(name.lower().replace('_', '-'))
    python[name] = {'requested': version, 'actual': actual}
commands = {}
for name in requested['utilities']:
    result = subprocess.run(['bash', '-c', 'type -t -- "$1"', 'bash', name], capture_output=True, text=True)
    commands[name] = result.stdout.strip() if result.returncode == 0 else None
imports = {}
for distribution, modules in requested['modules'].items():
    imports[distribution] = {}
    for name in modules:
        try:
            module = importlib.import_module(name)
            imports[distribution][name] = {'ok': True, 'path': getattr(module, '__file__', None)}
        except Exception as exc:
            imports[distribution][name] = {'ok': False, 'error': str(exc)}
sdk = subprocess.run(['/opt/computer-use/venv/bin/python', '-c', 'import modal_computer_use; print(modal_computer_use.__file__)'], capture_output=True, text=True)
connection = socket.socket()
connection.settimeout(3)
try:
    connection.connect(('1.1.1.1', 80))
    connection.sendall(b'GET / HTTP/1.1\r\nHost: 1.1.1.1\r\nConnection: close\r\n\r\n')
    outbound_response = connection.recv(4096)[:512].decode('latin1', errors='replace')
except OSError:
    outbound_response = ''
finally:
    connection.close()
marker = pathlib.Path('/opt/computer-use/image.json')
print(json.dumps({'python_version': sys.version, 'python_executable': sys.executable,
                  'path': os.environ['PATH'], 'uid': os.getuid(),
                  'no_new_privileges': pathlib.Path('/proc/self/status').read_text().split('NoNewPrivs:')[1].splitlines()[0].strip(),
                  'outbound_http_response': outbound_response,
                  'marker_owner_uid': marker.stat().st_uid, 'marker_writable_by_user': os.access(marker, os.W_OK),
                  'credential_names_present': [name for name in ('E2B_API_KEY', 'AI_GATEWAY_API_KEY', 'TURBOPUFFER_API_KEY') if name in os.environ],
                  'resolved_distributions': packages, 'apt_versions': apt_versions.stdout,
                  'apt_query_error': apt_versions.stderr, 'tool_venv_freeze': freeze.stdout,
                  'cli_venv_freeze': cli_freeze.stdout,
                  'python': python, 'utilities': commands, 'imports': imports,
                  'desktop_sdk': {'ok': sdk.returncode == 0, 'detail': sdk.stdout.strip() or sdk.stderr.strip()}}, sort_keys=True))'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--template', required=True)
    parser.add_argument('--image-sha256', required=True)
    parser.add_argument('--packages', type=pathlib.Path, required=True)
    parser.add_argument('--utilities', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()
    if len(args.image_sha256) != 64:
        parser.error('Expected a 64-character manifest SHA-256')
    lines = args.packages.read_text().splitlines()[2:]
    requested = {'python': {row.split()[0]: row.split()[1] for row in lines if row.strip()},
                 'utilities': [row.strip() for row in args.utilities.read_text().splitlines() if row.strip()]}
    requested['modules'] = {name: MODULE_OVERRIDES.get(name, [name.lower().replace('-', '_')])
                            for name in requested['python']}
    sandbox = Sandbox.create(template=args.template, timeout=600, secure=True,
                             network={'allow_public_traffic': False, 'deny_out': ['0.0.0.0/0']})
    try:
        sandbox.files.write('/tmp/requested-inventory.json', json.dumps(requested))
        sandbox.files.write('/tmp/image-probe.py', PROBE)
        marker = sandbox.files.read('/opt/computer-use/image.json')
        if hashlib.sha256(marker.encode()).hexdigest() != args.image_sha256:
            raise RuntimeError('Image marker SHA-256 does not match requested build')
        cmd = 'setpriv --no-new-privs -- python3 /tmp/image-probe.py'
        result = sandbox.commands.run(cmd, user='user', timeout=300)
        if result.exit_code != 0:
            raise RuntimeError('Image probe failed: ' + result.stderr)
        audit = json.loads(result.stdout)
        audit['image_sha256'] = args.image_sha256
        audit['template'] = args.template
        audit['inventory_sha256'] = {'python': hashlib.sha256(args.packages.read_bytes()).hexdigest(),
                                     'utilities': hashlib.sha256(args.utilities.read_bytes()).hexdigest()}
        audit['marker'] = json.loads(marker)
        args.output.write_text(json.dumps(audit, indent=2, sort_keys=True) + '\n')
        print(json.dumps({'output': str(args.output), 'python_present': sum(x['actual'] is not None for x in audit['python'].values()),
                          'command_present': sum(x is not None for x in audit['utilities'].values()),
                          'python_imports_ok': sum(x['ok'] for modules in audit['imports'].values() for x in modules.values()),
                          'python_imports_total': sum(len(modules) for modules in audit['imports'].values()),
                          'outbound_http_response': audit['outbound_http_response'].splitlines()[0] if audit['outbound_http_response'] else '(none)'}))
    finally:
        sandbox.kill()


if __name__ == '__main__':
    main()
