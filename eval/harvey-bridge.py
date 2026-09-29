"""Run upstream Harvey's model loop with its unchanged tools inside E2B."""

import base64
import hashlib
import importlib.metadata
import io
import json
import os
import re
import shlex
import subprocess
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path


HARVEY_COMMIT = "845a08840869b21a5c11958aae58bf5f00a7b775"
LUNA_MODEL = "openai/gpt-6-luna"
MODAL_MODEL = "deepseek/deepseek-v4.1-flash"
GATEWAY = "https://ai-gateway.vercel.sh/v1"
E2B_TEMPLATE = "gfkhlvaqlbbjrjm04d6d"
HARVEY_IMAGE = "ghcr.io/harveyai/lab-sandbox@sha256:96f6d1e51bc01de6f51e24539b7191c6a59c6b498f4646cec334d95f0717d6c2"
CORPUS_README = ("This directory contains the full evaluation source corpus, not reference answers or grading rubrics. "
                 "Search chunks with grep or other filesystem tools, then read the relevant files. Cite the exact chunk ID "
                 "shown in the first line in square brackets. index.json lists all chunk paths; documents.json lists "
                 "document metadata.\n")


def validate_corpus(documents, expected_hash):
    if set(path.name for path in documents.iterdir()) != {"README.txt", "index.json", "documents.json", "chunks"}:
        raise RuntimeError("Unexpected corpus export entries")
    for name in ("README.txt", "index.json", "documents.json"):
        if not (documents / name).is_file() or (documents / name).is_symlink():
            raise RuntimeError("Corpus metadata must be ordinary files")
    if (documents / "README.txt").read_text(encoding="utf-8") != CORPUS_README:
        raise RuntimeError("Corpus instructions differ from approved export")
    chunks = documents / "chunks"
    if not chunks.is_dir() or chunks.is_symlink():
        raise RuntimeError("Corpus chunk directory must be ordinary")
    index = json.loads((documents / "index.json").read_text(encoding="utf-8"))
    metadata = json.loads((documents / "documents.json").read_text(encoding="utf-8"))
    if not isinstance(index, list) or not index or not isinstance(metadata, list):
        raise RuntimeError("Invalid corpus index or document metadata")
    if any(not isinstance(doc, dict) or set(doc) - {"id", "title", "kind", "authors", "year", "chunk_count"} for doc in metadata):
        raise RuntimeError("Unexpected corpus document metadata")
    if len(list(chunks.iterdir())) != len(index):
        raise RuntimeError("Unexpected corpus chunk file")
    paths = []
    for row in index:
        if not isinstance(row, dict) or set(row) != {"id", "doc", "path", "sha256"} or not isinstance(row["id"], str):
            raise RuntimeError("Invalid corpus chunk manifest")
        if not re.fullmatch(r"[a-zA-Z0-9_-]+:[a-zA-Z0-9_:-]+", row["id"]) or row["path"] != f"chunks/{row['id']}.txt":
            raise RuntimeError("Invalid corpus chunk path")
        path = documents / row["path"]
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("Invalid corpus chunk file")
        contents = path.read_text(encoding="utf-8")
        prefix = f"[{row['id']}]\n"
        if not contents.startswith(prefix) or not contents.endswith("\n") or hashlib.sha256(contents[len(prefix):-1].encode()).hexdigest() != row["sha256"]:
            raise RuntimeError("Corpus chunk contents differ from manifest")
        paths.append(path)
    manifest = json.dumps({"version": "comparison-corpus-v1", "index": index, "documents": metadata},
                          ensure_ascii=False, separators=(",", ":"))
    if hashlib.sha256(manifest.encode()).hexdigest() != expected_hash:
        raise RuntimeError("Corpus export hash differs")
    return [documents / "README.txt", documents / "index.json", documents / "documents.json", *paths]


def smoke_pdf():
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length 55 >>\nstream\nBT /F1 18 Tf 72 720 Td (Harvey PDF parser smoke) Tj ET\nendstream",
    ]
    data = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, body in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f"{index} 0 obj\n".encode() + body + b"\nendobj\n")
    xref = len(data)
    data.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        data.extend(f"{offset:010} 00000 n \n".encode())
    data.extend(f"trailer\n<< /Root 1 0 R /Size {len(offsets)} >>\nstartxref\n{xref}\n%%EOF\n".encode())
    return bytes(data)


def redact_local(value):
    value = re.sub(r"(https?://)[^\s/@]+:[^\s/@]+@", r"\1[redacted]@", value)
    value = re.sub(r"([?&](?:token|key|secret|password|signature|authorization)=)[^\s&#\"',}]+", r"\1[redacted]", value, flags=re.I)
    value = re.sub(r"-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----", "[redacted private key]", value)
    for name, secret in os.environ.items():
        if re.search(r"KEY|TOKEN|SECRET|PASSWORD|PRIVATE", name, flags=re.I) and len(secret) >= 8:
            value = value.replace(secret, "[redacted]")
    return value


SENSITIVE_FIELD = re.compile(r"(?:^|[_-])(?:authorization|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|access[_-]?key|signature)(?:$|[_-])", re.I)
IMAGE_DATA = re.compile(r"data:image/[^\s;,]+;base64,[A-Za-z0-9+/=]+", re.I)
AUTH_VALUE = re.compile(r"\b(?:Bearer\s+(?!shares(?=$|[\s,;.!?)]))[A-Za-z0-9._~+/-]+=*|Basic\s+[A-Za-z0-9._~+/-]+=*)", re.I)
AUTH_HEADER = re.compile(r"\bAuthorization\s*[:=]\s*(?:Bearer|Basic)\s+[^\s,;]+", re.I)
SECRET_ASSIGNMENT = re.compile(r"(?i)(\b(?:authorization|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|client[_-]?secret|access[_-]?key)\b\s*[:=]\s*)(?:[\"']?)[^\s,;&}\"']+", re.I)
QUOTED_SECRET = re.compile(r'(?i)(["\'](?:authorization|password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|access[_-]?key)["\']\s*:\s*)(?:"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[^\s,;}]+)')
URL_WITH_QUERY = re.compile(r"https?://[^\s\"'<>]+", re.I)
URL_QUERY_SECRET = re.compile(r"([?&](?:[^=&]*(?:token|key|secret|password|signature|auth|credential)[^=&]*)=)[^\s&#\"',}]+", re.I)


def scrub_trajectory(value, field=""):
    normalized_field = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", field).lower()
    if SENSITIVE_FIELD.search(normalized_field) or normalized_field in {"headers", "reasoning", "reasoning_content", "provider_metadata", "image", "image_url", "base64", "image_data"}:
        return "[redacted]"
    if isinstance(value, dict):
        return {key: scrub_trajectory(item, key) for key, item in value.items()}
    if isinstance(value, list):
        return [scrub_trajectory(item, field) for item in value]
    if not isinstance(value, str):
        return value
    if normalized_field == "arguments":
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            pass
        else:
            cleaned = scrub_trajectory(parsed)
            return value if cleaned == parsed else json.dumps(cleaned, ensure_ascii=False, separators=(",", ":"))
    value = IMAGE_DATA.sub("[redacted image]", value)
    value = re.sub(r"(https?://)[^\s/@]+@", r"\1[redacted]@", value)
    value = URL_WITH_QUERY.sub(lambda match: URL_QUERY_SECRET.sub(r"\1[redacted]", match.group()), value)
    value = AUTH_HEADER.sub("[redacted authorization]", value)
    value = AUTH_VALUE.sub("[redacted authorization]", value)
    value = QUOTED_SECRET.sub(r"\1\"[redacted]\"", value)
    value = SECRET_ASSIGNMENT.sub(r"\1[redacted]", value)
    for name, secret in os.environ.items():
        if len(secret) >= 8 and name not in {"PATH", "PYTHONPATH", "PWD", "HOME", "SHELL", "LANG", "TERM"}:
            value = value.replace(secret, "[redacted]")
    return redact_local(value)


def evidence_receipt(payload):
    excluded = {"answer", "deliverables", "missingDeliverables", "materialHashes", "taskSha256"}
    receipt = scrub_trajectory({key: value for key, value in payload.items() if key not in excluded})
    receipt["receiptVersion"] = 2
    receipt["answerSha256"] = hashlib.sha256(payload["answer"].encode("utf-8")).hexdigest()
    if "taskSha256" in payload:
        receipt["taskSha256"] = payload["taskSha256"]
        receipt["materialHashes"] = payload["materialHashes"]
        receipt["deliverables"] = [{"file": row["file"], "sha256": row["sha256"]}
                                   for row in payload["deliverables"]]
        receipt["missingDeliverables"] = payload["missingDeliverables"]
    return receipt


class Trajectory:
    def __init__(self, path):
        self.path = path
        self.turn = 0
        self.pending = []
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        self.stream = os.fdopen(fd, "w", encoding="utf-8")

    def append(self, event, **fields):
        record = scrub_trajectory({"at": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                                   "event": event, **fields})
        self.stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        self.stream.flush()
        os.fsync(self.stream.fileno())

    def close(self):
        self.stream.close()


class TracedAdapter:
    def __init__(self, adapter, trajectory):
        self.adapter = adapter
        self.trajectory = trajectory

    def chat(self, messages, tools):
        trace = self.trajectory
        trace.turn += 1
        trace.append("model_call", turn=trace.turn, messageCount=len(messages))
        try:
            response = self.adapter.chat(messages, tools)
        except BaseException as error:
            trace.append("model_failure", turn=trace.turn, errorType=type(error).__name__)
            raise
        trace.pending = [(call.id, call.name, call.arguments) for call in response.tool_calls]
        trace.append("assistant", turn=trace.turn, text=response.text,
                     toolCalls=[{"id": call.id, "name": call.name, "arguments": call.arguments}
                                for call in response.tool_calls], inputTokens=response.input_tokens,
                     outputTokens=response.output_tokens)
        return response

    def make_tool_result_messages(self, results):
        messages = self.adapter.make_tool_result_messages(results)
        for call_id, result in results:
            self.trajectory.append("tool_result", turn=self.trajectory.turn, toolCallId=call_id, result=result)
        self.trajectory.pending = []
        return messages

    def make_system_message(self, content):
        return self.adapter.make_system_message(content)

    def make_user_message(self, content):
        message = self.adapter.make_user_message(content)
        self.trajectory.append("user", content=content)
        return message


active_trajectory = None

REMOTE_EXECUTOR = r'''
import base64
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, "/workspace/harvey")
from harness.tools import ToolExecutor
from sandbox.sandbox import Sandbox, ExecResult, WORKSPACE_PATH, DOCUMENTS_PATH, OUTPUT_PATH

class LocalE2BSandbox(Sandbox):
    def exec(self, command, *, cwd=WORKSPACE_PATH, timeout=None, env=None):
        self.assert_sandbox_path(cwd)
        timeout = timeout if timeout is not None else self.default_timeout
        environment = {**os.environ, "WORKSPACE_DIR": WORKSPACE_PATH,
            "DOCUMENTS_DIR": DOCUMENTS_PATH, "OUTPUT_DIR": OUTPUT_PATH, **(env or {})}
        wrapped = f"timeout --kill-after=2 {int(timeout)} bash -lc {shlex.quote(command)}"
        try:
            process = subprocess.run(["bash", "-c", wrapped], cwd=cwd, env=environment,
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout + 5)
            timed_out = process.returncode in (124, 137)
            return ExecResult(process.stdout, process.stderr, None if timed_out else process.returncode, timed_out)
        except subprocess.TimeoutExpired as error:
            return ExecResult(str(error.stdout or ""), str(error.stderr or ""), None, True)

def main():
    global active_trajectory
    request = json.loads(base64.b64decode(sys.argv[1]))
    sandbox = LocalE2BSandbox(documents_dir="/workspace/documents",
        output_dir="/workspace/output", workspace_dir="/workspace", default_timeout=60)
    executor = ToolExecutor(sandbox=sandbox)
    state_file = Path("/workspace/harvey-tool-state.json")
    if state_file.exists():
        state = json.loads(state_file.read_text())
        for field in ("files_read", "files_written", "files_edited", "bash_command_count", "glob_count", "grep_count"):
            setattr(executor, field, state[field])
    if request["action"] == "metrics":
        output = executor.get_metrics()
    elif request["action"] == "execute":
        output = executor.execute(request["tool"], request["arguments"])
    else:
        raise ValueError("Unknown Harvey executor action")
    state_file.write_text(json.dumps({field: getattr(executor, field) for field in
        ("files_read", "files_written", "files_edited", "bash_command_count", "glob_count", "grep_count")}))
    print(json.dumps(output, ensure_ascii=False))

if __name__ == "__main__":
    main()
'''


def create_archive(root, documents, source_files, smoke=False, work_product=None):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        for path in [root / "harness/__init__.py", root / "harness/tools.py",
                     root / "sandbox/__init__.py", root / "sandbox/sandbox.py",
                     root / "sandbox/parsers/parse_doc.py"]:
            archive.add(path, arcname=f"harvey/{path.relative_to(root)}")
        for path in sorted((root / "harness/skills").rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                archive.add(path, arcname=f"harvey/{path.relative_to(root)}")
                parts = path.relative_to(root / "harness/skills").parts
                if len(parts) >= 3 and parts[1] == "scripts":
                    archive.add(path, arcname=f"skills/{path.relative_to(root / 'harness/skills')}")
        for path in (documents, documents / "chunks"):
            info = archive.gettarinfo(path, arcname=f"documents/{path.relative_to(documents)}" if path != documents else "documents")
            info.mode = 0o555
            archive.addfile(info)
        for path in source_files:
            info = archive.gettarinfo(path, arcname=f"documents/{path.relative_to(documents)}")
            info.mode = 0o444
            with path.open("rb") as source:
                archive.addfile(info, source)
        if work_product:
            packet = work_product
            for row in packet["materials"]:
                data = row["content"].encode("utf-8")
                info = tarfile.TarInfo(f"task/{row['path']}")
                info.size = len(data)
                info.mode = 0o444
                archive.addfile(info, io.BytesIO(data))
            data = json.dumps(packet["task"], ensure_ascii=False).encode("utf-8")
            info = tarfile.TarInfo("task/task.json")
            info.size = len(data)
            info.mode = 0o444
            archive.addfile(info, io.BytesIO(data))
        if smoke:
            fixture_root = root / "tasks/antitrust-competition/analyze-antitrust-hsr-strategy/documents"
            for extension, name in [("docx", "crescent-ic-memo.docx"), ("xlsx", "market-data-branches.xlsx")]:
                archive.add(fixture_root / name, arcname=f"fixtures/smoke.{extension}")
            pdf = smoke_pdf()
            info = tarfile.TarInfo("fixtures/smoke.pdf")
            info.size = len(pdf)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(pdf))
    return stream.getvalue()


def corpus_checksum_command(documents):
    pipeline = f"find {shlex.quote(str(documents))} -type f -print0 | sort -z | xargs -0 -r sha256sum | sha256sum"
    return f"bash -o pipefail -c {shlex.quote(pipeline)}"


def collect_deliverables(sandbox, names):
    output_root = sandbox.commands.run("if test -d /workspace/output && test ! -L /workspace/output; then printf ok; else printf unsafe; fi", cwd="/workspace", user="user")
    if output_root.stdout.strip() != "ok":
        raise RuntimeError("Harvey output directory is unsafe")
    deliverables, missing = [], []
    for name in names:
        path = "/workspace/output/" + name
        quoted = shlex.quote(path)
        inspection = sandbox.commands.run(
            f"if test ! -e {quoted} && test ! -L {quoted}; then printf missing; "
            f"elif test -f {quoted} && test ! -L {quoted} && test \"$(stat -c %s {quoted})\" -le 1048576; "
            "then printf ok; else printf unsafe; fi", cwd="/workspace", user="user")
        status = inspection.stdout.strip()
        if status == "missing":
            missing.append(name)
            continue
        if status != "ok":
            raise RuntimeError("Harvey deliverable is unsafe or oversized")
        data = bytes(sandbox.files.read(path, format="bytes"))
        if len(data) > 1048576:
            raise RuntimeError("Harvey deliverable is oversized")
        content = data.decode("utf-8", errors="strict")
        deliverables.append({"file": name, "content": content, "sha256": hashlib.sha256(data).hexdigest()})
    return deliverables, missing


def final_answer_text(messages):
    final_message = messages[-1] if messages else {}
    final_content = final_message.get("content") if final_message.get("role") == "assistant" else None
    if isinstance(final_content, str):
        return final_content
    if isinstance(final_content, list):
        return "\n".join(item.get("text", "") for item in final_content if isinstance(item, dict))
    return "\n".join(
        content.get("text", "")
        for message in final_message.get("output", []) if message.get("type") == "message"
        for content in message.get("content", []) if isinstance(content, dict)
    )


def main():
    request = json.load(sys.stdin)
    root = Path(request["harvey_root"]).resolve(strict=True)
    documents = Path(request["documents"]).resolve(strict=True)
    artifacts = Path(request["artifacts"]).resolve()
    for source_root in (root, Path(__file__).resolve().parent.parent, documents):
        if artifacts == source_root or source_root in artifacts.parents:
            raise RuntimeError("Harvey artifacts must be outside source and corpus repositories")
    if subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip() != HARVEY_COMMIT:
        raise RuntimeError("Harvey upstream revision changed")
    if subprocess.check_output(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=all"], text=True).strip():
        raise RuntimeError("Harvey upstream checkout is dirty")
    smoke = "--smoke" in sys.argv[1:]
    model = request.get("model", LUNA_MODEL)
    provider_only = request.get("provider_only")
    if not ((model == LUNA_MODEL and provider_only is None) or
            (model == MODAL_MODEL and provider_only == ["modal"])):
        raise RuntimeError("Invalid Harvey model/provider pairing")
    if not smoke and (os.environ.get("OPENAI_BASE_URL", "").rstrip("/") != GATEWAY or not os.environ.get("OPENAI_API_KEY")):
        raise RuntimeError("Exact AI Gateway endpoint and credentials required")
    if not os.environ.get("E2B_API_KEY"):
        raise RuntimeError("E2B_API_KEY required")
    if not documents.is_dir() or not (documents / "index.json").is_file():
        raise RuntimeError("Prepared corpus documents missing")
    if importlib.metadata.version("e2b") != "2.34.0":
        raise RuntimeError("Pinned E2B SDK version required")

    sys.path.insert(0, str(root))
    from e2b import Sandbox as E2BSandbox
    from harness.adapters.openai import OpenAIAdapter
    from harness.agent_loop import run_agent
    from harness.run import DEFAULT_SKILLS, SYSTEM_PROMPT_PREAMBLE, load_skills
    from harness.tools import get_all_tool_definitions

    tools = get_all_tool_definitions()
    if sorted(tool["name"] for tool in tools) != ["bash", "edit", "glob", "grep", "read", "write"]:
        raise RuntimeError("Harvey tool policy changed")
    prompt = SYSTEM_PROMPT_PREAMBLE + load_skills(DEFAULT_SKILLS)
    artifacts.mkdir(parents=True, exist_ok=False, mode=0o700)
    trajectory = Trajectory(artifacts / "trajectory.jsonl") if not smoke else None
    active_trajectory = trajectory
    if trajectory:
        trajectory.append("run_start", model=model)
    source_files = validate_corpus(documents, request["corpus_hash"])
    work_product = request.get("work_product")
    if work_product:
        task = work_product["task"]
        names = task["deliverables"]
        paths = task["materials"]
        valid = r"[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:md|csv|txt)"
        if (set(task) != {"id", "title", "instructions", "scope", "deliverables", "materials"} or
                set(task["scope"]) != {"jurisdiction", "companyForm", "asOf"} or
                not all(isinstance(value, str) and value.strip() for value in
                        [task["id"], task["title"], task["instructions"], *task["scope"].values()]) or
                not isinstance(names, list) or not names or not all(isinstance(name, str) and re.fullmatch(valid, name) for name in names) or
                not isinstance(paths, list) or not all(isinstance(path, str) and re.fullmatch("materials/" + valid, path) for path in paths) or
                len({name.lower() for name in names}) != len(names) or len({path.lower() for path in paths}) != len(paths) or
                not isinstance(work_product["materials"], list) or
                len(work_product["materials"]) != len(paths) or
                any(set(row) != {"path", "content"} or row["path"] not in paths or not isinstance(row["content"], str)
                    for row in work_product["materials"]) or
                {row["path"] for row in work_product["materials"]} != set(paths)):
            raise ValueError("Invalid public work-product packet")
    archive = create_archive(root, documents, source_files, smoke=smoke, work_product=work_product)
    sandbox = E2BSandbox.create(template=E2B_TEMPLATE, secure=True, allow_internet_access=False,
                                timeout=3600, api_key=os.environ["E2B_API_KEY"])
    try:
        setup = sandbox.commands.run("mkdir -p /workspace && chown root:root /workspace && chmod 1777 /workspace", user="root")
        if setup.exit_code != 0:
            raise RuntimeError("E2B workspace preparation failed")
        sandbox.files.write("/workspace/corpus-and-harvey.tar.gz", archive)
        sandbox.files.write("/workspace/harvey-rpc.py", REMOTE_EXECUTOR)
        unpack = sandbox.commands.run(
            "tar --no-same-owner --same-permissions --delay-directory-restore -xzf /workspace/corpus-and-harvey.tar.gz -C /workspace && "
            "mkdir -p /workspace/output && chown root:root /workspace/output && chmod 1777 /workspace/output && "
            "chown root:root /workspace/corpus-and-harvey.tar.gz /workspace/harvey-rpc.py && "
            "chmod 444 /workspace/harvey-rpc.py && chmod 400 /workspace/corpus-and-harvey.tar.gz && "
            "cp /workspace/harvey/sandbox/parsers/parse_doc.py /usr/local/bin/parse-doc && chmod 755 /usr/local/bin/parse-doc && "
            "chown -R root:root /workspace/documents && "
            "find /workspace/documents -type d -exec chmod 555 {} + && "
            "find /workspace/documents -type f -exec chmod 444 {} +" +
            (" && chown -R root:root /workspace/task && find /workspace/task -type d -exec chmod 555 {} + && find /workspace/task -type f -exec chmod 444 {} +" if work_product else ""),
            cwd="/workspace", user="root", timeout=120)
        if unpack.exit_code != 0:
            raise RuntimeError("E2B corpus upload failed")
        checksum = corpus_checksum_command("/workspace/documents")
        initial_hash = sandbox.commands.run(checksum, cwd="/workspace", user="user", timeout=120)
        if initial_hash.exit_code != 0:
            raise RuntimeError("E2B corpus integrity preflight failed")

        def rpc(payload):
            argument = base64.b64encode(json.dumps(payload).encode()).decode()
            command = f"setpriv --no-new-privs -- python3 /workspace/harvey-rpc.py {shlex.quote(argument)}"
            response = sandbox.commands.run(command, cwd="/workspace", user="user", timeout=130)
            if response.exit_code != 0:
                raise RuntimeError("Remote Harvey tool execution failed")
            return json.loads(response.stdout)

        if smoke:
            sample = request["sample"]
            path = sample["path"]
            if not re.fullmatch(r"chunks/[a-zA-Z0-9_:./-]+\.txt", path) or not (documents / path).is_file():
                raise RuntimeError("Invalid smoke source")
            calls = [
                ("glob", {"pattern": "chunks/*.txt"}),
                ("grep", {"pattern": re.escape(sample["id"]), "path": "chunks",
                          "glob": Path(path).name, "output_mode": "content"}),
                ("read", {"file_path": path, "limit": 2}),
                ("write", {"file_path": "smoke.md", "content": "Harvey smoke original"}),
                ("edit", {"file_path": "smoke.md", "old_string": "original", "new_string": "edited"}),
                ("bash", {"command": "cat /workspace/output/smoke.md"}),
            ]
            results = [{"tool": tool, "result": rpc({"action": "execute", "tool": tool, "arguments": args})} for tool, args in calls]
            checks = [
                "test ! -w /workspace/documents && test ! -w /workspace/harvey/harness/tools.py && test ! -w /workspace/harvey-rpc.py",
                "test \"$(stat -c %a /workspace)\" = 1777 && test \"$(stat -c %u /workspace/documents)\" = 0 && test \"$(stat -c %u /workspace/harvey-rpc.py)\" = 0",
                "if mv /workspace/documents /workspace/documents-renamed 2>/dev/null; then exit 1; fi",
                "if sudo -n sh -c 'touch /workspace/documents/injected' 2>/dev/null; then exit 1; fi",
                "test -z \"${AI_GATEWAY_API_KEY:-}\" && test -z \"${E2B_API_KEY:-}\"",
                "python3 -c 'import urllib.request; urllib.request.urlopen(\"https://example.com\", timeout=3)' >/dev/null 2>&1 && exit 1 || exit 0",
            ]
            security = [{"command": cmd, "result": rpc({"action": "execute", "tool": "bash", "arguments": {"command": cmd}})} for cmd in checks]
            parser = rpc({"action": "execute", "tool": "bash", "arguments": {
                "command": "command -v parse-doc && command -v pandoc && python3 -c 'import pandas,pdfplumber,markitdown'"}})
            binary = {extension: rpc({"action": "execute", "tool": "read", "arguments": {
                "file_path": f"/workspace/fixtures/smoke.{extension}", "limit": 12}})
                for extension in ("docx", "pdf", "xlsx")}
            skill = rpc({"action": "execute", "tool": "bash", "arguments": {
                "command": "python3 /workspace/skills/docx/scripts/validate.py /workspace/fixtures/smoke.docx"}})
            xlsx_skill = rpc({"action": "execute", "tool": "bash", "arguments": {
                "command": "python3 /workspace/skills/xlsx/scripts/scan_errors.py /workspace/fixtures/smoke.xlsx"}})
            final_hash = sandbox.commands.run(checksum, cwd="/workspace", user="user", timeout=120)
            report = {"tools": results, "security": security,
                "template_id": E2B_TEMPLATE, "harvey_base_image": HARVEY_IMAGE,
                "binary_parser_available": "(exit code" not in parser and not parser.startswith("Error:"),
                "binary_parser_check": parser[:1000],
                "binary_reads": {extension: text[:1000] for extension, text in binary.items()},
                "docx_skill_validation": skill[:1000],
                "xlsx_skill_scan": xlsx_skill[:1000],
                "corpus_unchanged": final_hash.exit_code == 0 and final_hash.stdout == initial_hash.stdout}
            (artifacts / "smoke-result.json").write_text(redact_local(json.dumps(report, ensure_ascii=False)), encoding="utf-8")
            print(redact_local(json.dumps(report, ensure_ascii=False)))
            expected = ["chunks/" in results[0]["result"], sample["id"] in results[1]["result"],
                        results[2]["result"].startswith(f"[{sample['id']}]"),
                        results[3]["result"] == "Wrote 21 bytes to smoke.md",
                        results[4]["result"] == "Replaced 1 occurrence(s) in smoke.md",
                        results[5]["result"] == "Harvey smoke edited"]
            if (not all(expected) or not report["binary_parser_available"] or
                    any(text.startswith("Error:") or not text.strip() for text in binary.values()) or
                    not skill.startswith("OK:") or '"count": 0' not in xlsx_skill or
                    not report["corpus_unchanged"] or
                    any(entry["result"] != "(no output)" for entry in security)):
                raise RuntimeError("E2B security smoke failed")
            return

        class RemoteExecutor:
            def execute(self, tool, arguments):
                call_id = trajectory.pending[0][0] if trajectory.pending else None
                try:
                    result = self.rpc({"action": "execute", "tool": tool, "arguments": arguments})
                except BaseException as error:
                    trajectory.append("tool_failure", turn=trajectory.turn, toolCallId=call_id, tool=tool,
                                      arguments=arguments, errorType=type(error).__name__)
                    raise
                if trajectory.pending:
                    trajectory.pending.pop(0)
                trajectory.append("tool_output", turn=trajectory.turn, toolCallId=call_id,
                                  tool=tool, arguments=arguments, result=result)
                with (artifacts / "tool-results.jsonl").open("a", encoding="utf-8") as stream:
                    stream.write(json.dumps(scrub_trajectory({"tool": tool, "arguments": arguments, "result": result}), ensure_ascii=False) + "\n")
                return result

            def get_metrics(self):
                return self.rpc({"action": "metrics"})

            def rpc(self, payload):
                return rpc(payload)

        if provider_only:
            from importlib.util import module_from_spec, spec_from_file_location
            spec = spec_from_file_location("harvey_modal_adapter", Path(__file__).with_name("harvey-modal-adapter.py"))
            module = module_from_spec(spec)
            spec.loader.exec_module(module)
            adapter = module.ModalDeepSeekAdapter(model=model, max_tokens=request.get("max_completion_tokens", 4000), capture_usage=bool(work_product))
        else:
            adapter = OpenAIAdapter(model=model, max_tokens=request.get("max_completion_tokens", 4000))
        result = run_agent(
            adapter=TracedAdapter(adapter, trajectory),
            system_prompt=prompt,
            user_prompt=(
                ("Rédige les livrables demandés par le dossier public /workspace/task/task.json. "
                 "Lis les matériaux sous /workspace/task/materials et recherche les sources juridiques dans /workspace/documents. "
                 "Écris chaque livrable déclaré dans /workspace/output/ sous son nom exact. "
                 "Cite les identifiants de chunks [id] pour les affirmations juridiques importantes, "
                 "signale les limites et ne cherche aucun barème ni corrigé. La réponse finale ne remplace pas les fichiers.\n\n"
                 "Demande : " + request["question"] + "\n\n" + task["instructions"])
                if work_product else
                "Réponds à la question de droit luxembourgeois uniquement avec les fichiers du corpus "
                "dans /workspace/documents. Cherche les passages pertinents avec les outils du workspace. "
                "Réponds en français en 120 mots maximum dans output/response.md. Cite pour chaque affirmation "
                "importante les identifiants exacts [doc-XX:...:cN] visibles avec les passages lus. "
                "Si les documents ne suffisent pas, signale les limites. N'utilise aucune source externe.\n\n"
                "Question : " + request["question"]
            ),
            tool_executor=RemoteExecutor(),
            tools=tools,
            max_turns=request["max_steps"],
            transcript_path=None,
        )
        final_text = final_answer_text(result["messages"])
        if work_product:
            answer = final_text
            deliverables, missing = collect_deliverables(sandbox, task["deliverables"])
        else:
            answer = sandbox.files.read("/workspace/output/response.md") if sandbox.files.exists("/workspace/output/response.md") else final_text
        final_hash = sandbox.commands.run(checksum, cwd="/workspace", user="user", timeout=120)
        if final_hash.exit_code != 0 or final_hash.stdout != initial_hash.stdout:
            raise RuntimeError("E2B source corpus changed during Harvey run")
    finally:
        sandbox.kill()

    payload = {
        "answer": answer,
        "template_id": E2B_TEMPLATE,
        "harvey_base_image": HARVEY_IMAGE,
        "finished_cleanly": result["finished_cleanly"],
        "turn_count": result["turn_count"],
        "input_tokens": result["input_tokens"],
        "output_tokens": result["output_tokens"],
        "wall_clock_seconds": result["wall_clock_seconds"],
        "tool_metrics": result["tool_metrics"],
        "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(),
        "tool_names": [tool["name"] for tool in tools],
        **({"deliverables": deliverables, "missingDeliverables": missing,
            "provider_usage_records": getattr(adapter, "usage_records", None),
            "materialHashes": {row["path"]: hashlib.sha256(row["content"].encode("utf-8")).hexdigest() for row in work_product["materials"]},
            "taskSha256": hashlib.sha256(json.dumps(task, ensure_ascii=False).encode("utf-8")).hexdigest()} if work_product else {}),
    }
    (artifacts / "bridge-result.json").write_text(json.dumps(evidence_receipt(payload), ensure_ascii=False), encoding="utf-8")
    trajectory.append("run_complete", finishedCleanly=result["finished_cleanly"], turnCount=result["turn_count"])
    trajectory.close()
    active_trajectory = None
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except BaseException as error:
        if active_trajectory is not None:
            active_trajectory.append("run_failure", errorType=type(error).__name__)
            active_trajectory.close()
        raise
