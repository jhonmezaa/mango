"""FinOps golden-set evaluation against a deployed installation (spec §4 and §13).

Run from the repository root:
  uv run --no-project --with boto3 --with pycognito --with pyotp --with httpx \
    python tests/eval/run.py --profile <mango account> --payer-profile <payer account> \
    --stack Mango-<ns>-Core --secrets <e2e secrets file> \
    --user central=<email> --user <area>=<email of a lead of that area>
"""

from __future__ import annotations

import sys

from finops_eval.cli import main

if __name__ == "__main__":
    sys.exit(main())
