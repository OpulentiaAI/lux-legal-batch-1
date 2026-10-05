import importlib
import importlib.metadata
import ctypes
import json
import pathlib
import sys


root = pathlib.Path(sys.argv[1])
if sys.version_info[:2] != (3, 12) or pathlib.Path(sys.prefix) != root / "venv":
    raise RuntimeError("The isolated prepared Python 3.12 virtualenv is required")
lock = json.loads((root / "python-wheels.json").read_text())
versions = {}
for item in lock["packages"]:
    version = importlib.metadata.version(item["name"])
    if version != item["version"]:
        raise RuntimeError("Installed Python version differs from lock: " + item["name"])
    versions[item["name"]] = version
modules = ["pymupdf", "pypdf", "pdfplumber", "docx", "pptx", "openpyxl", "xlsxwriter",
           "PIL", "reportlab", "bs4", "lxml", "defusedxml", "pytesseract", "yaml", "pandas",
           "pyarrow", "ebooklib"]
for name in modules:
    importlib.import_module(name)
ctypes.CDLL("libseccomp.so.2")
print(json.dumps({"verified": True, "python": sys.version.split()[0],
                  "versions": versions, "importedModules": modules, "libseccomp": "libseccomp.so.2 loaded"}))
