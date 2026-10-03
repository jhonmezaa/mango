"""FinOps golden-set evaluation against a deployed installation (spec §4 and §13).

Run from the repository root:
  uv run --no-project --with boto3 --with pycognito --with pyotp --with httpx \
    python tests/eval/run.py --profile mango-sandbox --payer-profile mango-mgmt \
    --secrets ~/.config/mango/lab/e2e-secrets.json
"""

from __future__ import annotations

import sys

from finops_eval.cli import main

if __name__ == "__main__":
    sys.exit(main())
