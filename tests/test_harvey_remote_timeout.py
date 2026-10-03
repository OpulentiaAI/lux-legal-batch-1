import ast
import json
import tempfile
import unittest
from pathlib import Path


class RemoteTimeoutTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[1] / "eval/harvey-bridge.py"
        tree = ast.parse(source.read_text())
        node = next(item for item in ast.walk(tree) if isinstance(item, ast.ClassDef) and item.name == "RemoteExecutor")
        self.events = []

        class Trace:
            pending = [("call-1", "write", "{}")]
            turn = 1

            def append(_, event, **data):
                self.events.append({"event": event, **data})

        class TimeoutException(Exception):
            pass

        self.timeout = TimeoutException
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        namespace = {"trajectory": Trace(), "artifacts": Path(self.directory.name), "json": json,
                     "scrub_trajectory": lambda value: value, "E2BTimeoutException": TimeoutException}
        exec(compile(ast.Module(body=[node], type_ignores=[]), str(source), "exec"), namespace)
        self.executor = namespace["RemoteExecutor"]()
        self.trace = namespace["trajectory"]

    def test_transport_timeout_is_visible_without_replaying_a_mutation(self):
        calls = []

        def rpc(payload):
            calls.append(payload)
            raise self.timeout("private provider details")

        self.executor.rpc = rpc
        result = self.executor.execute("write", '{"file_path":"memo.md","content":"memo"}')
        self.assertEqual(len(calls), 1)
        self.assertIn("execution state is unknown", result)
        self.assertIn("Inspect state before retrying writes", result)
        self.assertNotIn("private", result)
        self.assertEqual(self.trace.pending, [])
        self.assertEqual([event["event"] for event in self.events], ["tool_failure", "tool_output"])
        capture = json.loads((Path(self.directory.name) / "tool-results.jsonl").read_text())
        self.assertEqual(capture["result"], result)

    def test_permission_failure_remains_fatal(self):
        def rpc(payload):
            raise PermissionError("fixture")

        self.executor.rpc = rpc
        with self.assertRaises(PermissionError):
            self.executor.execute("read", "{}")
        self.assertEqual(len(self.trace.pending), 1)
        self.assertEqual([event["event"] for event in self.events], ["tool_failure"])


if __name__ == "__main__":
    unittest.main()
