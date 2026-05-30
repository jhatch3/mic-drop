"""Backend oracle keypair (Stream A → D integration).

The oracle is the only key that can call `settle()` or `refund()` on the Anchor
escrow program (enforced by `has_one = oracle` on the match account). It must
live on the backend — never the client — per CLAUDE.md invariant #6.

Loads from ORACLE_KEYPAIR_PATH. If the file is missing AND we're pointed at
devnet, generate one + write it back so demo setup is one-step. In prod this
file would be provisioned out-of-band.

Frontend reads `GET /api/oracle/pubkey` and passes that into `create_match`
so the on-chain `oracle` field matches what the backend will sign with.
"""
from __future__ import annotations

import json
import logging
import os
import time
from functools import lru_cache
from pathlib import Path

from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solana.rpc.api import Client

log = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_KEYPAIR_PATH = REPO_ROOT / "oracle-keypair.json"
RPC_URL = os.getenv("SOLANA_RPC_URL", "https://api.devnet.solana.com")
MIN_BALANCE_LAMPORTS = 50_000_000  # ~0.05 SOL — enough for ~25 settle txs


def _keypair_path() -> Path:
    p = os.getenv("ORACLE_KEYPAIR_PATH")
    return Path(p) if p else DEFAULT_KEYPAIR_PATH


def _read_keypair_file(path: Path) -> Keypair:
    """Anchor/solana-cli store keypairs as a JSON array of 64 ints (secret)."""
    data = json.loads(path.read_text())
    return Keypair.from_bytes(bytes(data))


def _write_keypair_file(path: Path, kp: Keypair) -> None:
    path.write_text(json.dumps(list(bytes(kp))))
    path.chmod(0o600)


@lru_cache(maxsize=1)
def oracle_keypair() -> Keypair:
    """Cached for the lifetime of the process — one oracle per backend instance."""
    path = _keypair_path()
    if path.exists():
        kp = _read_keypair_file(path)
        log.info("loaded oracle keypair: %s", kp.pubkey())
        return kp

    # Auto-generate only on devnet — refuse to fabricate one against mainnet.
    if "devnet" not in RPC_URL and "localhost" not in RPC_URL:
        raise RuntimeError(
            f"oracle keypair not found at {path} and refusing to generate "
            f"one against {RPC_URL!r}. Provision the file out-of-band."
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    kp = Keypair()
    _write_keypair_file(path, kp)
    log.warning("generated new oracle keypair at %s (pubkey=%s)", path, kp.pubkey())
    return kp


def oracle_pubkey() -> Pubkey:
    return oracle_keypair().pubkey()


def ensure_funded(min_lamports: int = MIN_BALANCE_LAMPORTS) -> int:
    """Top up the oracle on devnet if it's running low. No-op on mainnet.

    Returns the post-airdrop balance.
    """
    client = Client(RPC_URL)
    pubkey = oracle_pubkey()
    bal_resp = client.get_balance(pubkey)
    bal = bal_resp.value
    if bal >= min_lamports:
        return bal
    if "devnet" not in RPC_URL and "localhost" not in RPC_URL:
        log.warning("oracle %s low (%d lamports) — manual top-up required", pubkey, bal)
        return bal

    log.info("oracle %s balance=%d, requesting airdrop", pubkey, bal)
    try:
        sig = client.request_airdrop(pubkey, 1_000_000_000).value  # 1 SOL
    except Exception as e:  # noqa: BLE001
        log.warning("airdrop request failed: %s", e)
        return bal

    # Best-effort wait for the airdrop to land. Don't block forever.
    deadline = time.time() + 30
    while time.time() < deadline:
        bal = client.get_balance(pubkey).value
        if bal >= min_lamports:
            log.info("oracle funded: %d lamports (sig=%s)", bal, sig)
            return bal
        time.sleep(2)
    log.warning("airdrop did not land within 30s (sig=%s, bal=%d)", sig, bal)
    return bal
