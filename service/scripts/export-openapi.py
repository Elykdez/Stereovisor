"""Write the service's OpenAPI document.

The schema is the client/server contract. Emitting it as a file lets a build
diff it, and lets a non-renderer client be generated from it later.

    python service/scripts/export-openapi.py [output-path]
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


PROJECT_ROOT = Path(os.environ.get("STEREOVISOR_APP_ROOT", Path(__file__).resolve().parents[2]))
sys.path.insert(0, str(PROJECT_ROOT))


def main() -> int:
    from service.src.app import app

    target = Path(sys.argv[1]) if len(sys.argv) > 1 else PROJECT_ROOT / "openapi.json"
    document = app.openapi()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    paths = document.get("paths", {})
    capabilities = [
        path
        for path in paths
        if path == "/api/capabilities"
        or path.startswith("/api/jobs/capabilities/")
    ]
    print(f"wrote {target} ({len(paths)} paths, {len(capabilities)} capability routes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
