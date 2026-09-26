import base64
import json
import pathlib
import subprocess
import sys
import urllib.error
import urllib.request
import uuid


def console(encoded):
    import websockets.sync.client

    request = json.loads(base64.b64decode(encoded))
    focus = subprocess.run(
        ['xdotool', 'getwindowfocus', 'getwindowclassname'],
        env={'DISPLAY': ':99'}, capture_output=True, text=True, check=True,
    ).stdout.strip().lower()
    if 'chrom' not in focus:
        raise RuntimeError('Chromium must be in the foreground')
    with urllib.request.urlopen('http://127.0.0.1:9222/json/list', timeout=5) as response:
        pages = json.load(response)
    page = next((item for item in pages if item.get('type') == 'page'), None)
    if page is None:
        raise RuntimeError('No Chromium page is available')
    with websockets.sync.client.connect(page['webSocketDebuggerUrl'], origin='http://127.0.0.1:9222') as ws:
        ws.send(json.dumps({'id': 1, 'method': 'Runtime.enable'}))
        ws.send(json.dumps({'id': 2, 'method': 'Log.enable'}))
        if request.get('content'):
            ws.send(json.dumps({
                'id': 3, 'method': 'Runtime.evaluate',
                'params': {'expression': request['content'], 'returnByValue': True, 'awaitPromise': True},
            }))
        pending = {1, 2, 3} if request.get('content') else {1, 2}
        entries = []
        value = None
        while pending:
            event = json.loads(ws.recv(timeout=10))
            if event.get('id') in pending:
                pending.remove(event['id'])
                if event['id'] == 3:
                    if 'exceptionDetails' in event.get('result', {}):
                        raise RuntimeError('Browser JavaScript evaluation failed')
                    value = event['result']['result'].get('value')
            elif event.get('method') in ('Log.entryAdded', 'Runtime.consoleAPICalled'):
                entries.append(event['params'])
    print(json.dumps({'result': value, 'entries': entries}))


def main():
    request = json.loads(base64.b64decode(sys.argv[1]))
    token = pathlib.Path('/tmp/computer-use/token').read_text().strip()
    url = 'http://127.0.0.1:8080' + request['path']
    body = json.dumps(request['body']).encode() if 'body' in request else None
    req = urllib.request.Request(
        url, data=body, method=request['method'],
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as response:
            data = response.read()
            print(json.dumps({'status': response.status, 'data': base64.b64encode(data).decode()}))
    except urllib.error.HTTPError as error:
        print(json.dumps({'status': error.code, 'data': base64.b64encode(error.read()).decode()}))


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == 'console':
        console(sys.argv[2])
    else:
        main()
