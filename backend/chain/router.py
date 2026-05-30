"""Read-only Solana endpoints (Stream A → C handshake).

Frontend Host calls GET /api/oracle/pubkey on mount and passes the result into
`create_match(..., oracle, ...)` so the on-chain match locks itself to the same
key the backend will later sign settle() with.
"""
import logging
import os

from fastapi import APIRouter

from .escrow import PROGRAM_ID, TREASURY_PUBKEY
from .oracle import RPC_URL, oracle_pubkey

router = APIRouter()
log = logging.getLogger(__name__)


@router.get("/oracle/pubkey")
def get_oracle_pubkey() -> dict:
    """Return everything the laptop needs to create a match the backend can settle."""
    return {
        "oracle_pubkey": str(oracle_pubkey()),
        "program_id": str(PROGRAM_ID),
        "treasury_pubkey": str(TREASURY_PUBKEY),
        "escrow_mode": os.getenv("ESCROW_MODE", "mock"),
        "rpc_url": RPC_URL,
    }
