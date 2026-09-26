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
from pathlib import Path


HARVEY_COMMIT = "845a08840869b21a5c11958aae58bf5f00a7b775"
MODEL = "openai/gpt-6-luna"
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


def create_archive(root, documents, source_files, smoke=False):
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
        for path in source_files:
            archive.add(path, arcname=f"documents/{path.relative_to(documents)}")
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
    artifacts.mkdir(parents=True, exist_ok=False)
    source_files = validate_corpus(documents, request["corpus_hash"])
    archive = create_archive(root, documents, source_files, smoke=smoke)
    sandbox = E2BSandbox.create(template=E2B_TEMPLATE, secure=True, allow_internet_access=False,
                                timeout=3600, api_key=os.environ["E2B_API_KEY"])
    try:
        setup = sandbox.commands.run("mkdir -p /workspace && chown root:root /workspace && chmod 1777 /workspace", user="root")
        if setup.exit_code != 0:
            raise RuntimeError("E2B workspace preparation failed")
        sandbox.files.write("/workspace/corpus-and-harvey.tar.gz", archive)
        sandbox.files.write("/workspace/harvey-rpc.py", REMOTE_EXECUTOR)
        unpack = sandbox.commands.run(
            "tar --no-same-owner -xzf /workspace/corpus-and-harvey.tar.gz -C /workspace && "
            "mkdir -p /workspace/output && chown root:root /workspace/output && chmod 1777 /workspace/output && "
            "chown root:root /workspace/corpus-and-harvey.tar.gz /workspace/harvey-rpc.py && "
            "chmod 444 /workspace/harvey-rpc.py && chmod 400 /workspace/corpus-and-harvey.tar.gz && "
            "cp /workspace/harvey/sandbox/parsers/parse_doc.py /usr/local/bin/parse-doc && chmod 755 /usr/local/bin/parse-doc && "
            "chmod -R a-w /workspace/documents",
            cwd="/workspace", user="root", timeout=120)
        if unpack.exit_code != 0:
            raise RuntimeError("E2B corpus upload failed")
        checksum = "find /workspace/documents -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum"
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
                result = self.rpc({"action": "execute", "tool": tool, "arguments": arguments})
                with (artifacts / "tool-results.jsonl").open("a", encoding="utf-8") as stream:
                    stream.write(redact_local(json.dumps({"tool": tool, "arguments": arguments, "result": result}, ensure_ascii=False)) + "\n")
                return result

            def get_metrics(self):
                return self.rpc({"action": "metrics"})

            def rpc(self, payload):
                return rpc(payload)

        adapter = OpenAIAdapter(model=MODEL, max_tokens=4000)
        result = run_agent(
            adapter=adapter,
            system_prompt=prompt,
            user_prompt=(
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
        with (artifacts / "transcript.jsonl").open("w", encoding="utf-8") as stream:
            for message in result["messages"]:
                stream.write(redact_local(json.dumps(message, default=str, ensure_ascii=False)) + "\n")
        final_messages = result["messages"][-1].get("output", []) if result["messages"] else []
        final_text = "\n".join(
            content.get("text", "")
            for message in final_messages if message.get("type") == "message"
            for content in message.get("content", []) if isinstance(content, dict)
        )
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
    }
    (artifacts / "bridge-result.json").write_text(redact_local(json.dumps(payload, ensure_ascii=False)), encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main()
