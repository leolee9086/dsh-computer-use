"""Pure AT-SPI reader/identity contracts; no Linux bus or Harness substitute."""
import ast
import os
from pathlib import Path
from types import SimpleNamespace
import unittest

# Compile the real helper's pure functions. Importing its pyatspi entrypoint needs a Linux desktop.
path = Path(__file__).resolve().parents[1] / "src" / "linux-atspi.py"
parsed = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
names = {"safe", "state_contains", "attributes_of", "process_id_of", "process_path_of", "verify_identity", "read_element"}
module = ast.Module(body=[node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name in names], type_ignores=[])
functions = {"os": os, "pyatspi": SimpleNamespace(STATE_PROTECTED=1)}
exec(compile(module, str(path), "exec"), functions)

class Text:
    characterCount = 10
    caretOffset = 3
    def __init__(self): self.requests = []
    def getText(self, start, end):
        self.requests.append((start, end))
        return "0123456789"[start:end]
    def getNSelections(self): return 1
    def getSelection(self, index): return (2, 9)

class Element:
    name = "Editor"
    def __init__(self, role="text"):
        self.role = role
        self.text = Text()
        self.text_queries = 0
    def getRoleName(self): return self.role
    def get_process_id(self): return 77
    def getAttributes(self): return ["id:fixture", "class:Editor"]
    def getState(self): return SimpleNamespace(contains=lambda constant: False)
    def queryText(self):
        self.text_queries += 1
        return self.text
    def queryValue(self): return None
    def querySelection(self): return None

class ReaderContracts(unittest.TestCase):
    def test_operation_parameters_do_not_change_identity(self):
        element = Element()
        functions["verify_identity"](element, {"processId": 77, "name": "Editor", "kind": "read", "value": "new", "elementId": "atspi:0,1"})
        with self.assertRaisesRegex(RuntimeError, "name changed"):
            functions["verify_identity"](element, {"processId": 77, "name": "replaced"})
        with self.assertRaisesRegex(RuntimeError, "process changed"):
            functions["verify_identity"](element, {"processId": 78})

    def test_bounded_text_and_selection(self):
        element = Element()
        result = functions["read_element"](element, {"maxChars": 3})
        self.assertEqual(result["text"], "012")
        self.assertTrue(result["text_truncated"])
        self.assertEqual(result["selection"][0]["text"], "234")
        self.assertTrue(all(end - start <= 3 for start, end in element.text.requests))

    def test_password_does_not_query_content(self):
        element = Element("password text")
        result = functions["read_element"](element, {"maxChars": 3})
        self.assertTrue(result["redacted"])
        self.assertEqual(element.text_queries, 0)
        self.assertNotIn("text", result)

    def test_invalid_ranges_and_grid_are_rejected(self):
        for args in [{"start": 8, "end": 11}, {"maxChars": 0}, {"column": 0}]:
            with self.assertRaises(RuntimeError): functions["read_element"](Element(), args)

    def test_search_is_bounded_and_missing_text_is_explicit(self):
        element = Element()
        with self.assertRaisesRegex(RuntimeError, "bounded"):
            functions["read_element"](element, {"maxChars": 3, "text": "789"})
        self.assertEqual(element.text.requests, [(0, 3)])

if __name__ == "__main__": unittest.main()
