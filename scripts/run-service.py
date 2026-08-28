from __future__ import annotations

import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

try:
    import uvicorn
except ModuleNotFoundError:
    # A user-supplied CUDA Python may own the AI stack while uvicorn remains in
    # the managed core environment. Append, rather than prepend, so that the
    # selected Python's Torch and model packages remain authoritative.
    managed_site = PROJECT_ROOT / ".venv" / "Lib" / "site-packages"
    if managed_site.is_dir():
        sys.path.append(str(managed_site))
    import uvicorn


if __name__ == "__main__":
    uvicorn.run("service.app:app", host="127.0.0.1", port=5179)
