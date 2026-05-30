"""Python settle()/refund() for the pitch_battle Anchor program.

Re-implements the two oracle-only instructions in Python so the backend can
settle wagers without shelling out to Node. Discriminators are taken straight
from the deployed program's IDL (see frontend/src/idl/pitch_battle.json):

    settle: [175, 42, 185, 87, 144, 131, 102, 212]
    refund: [  2, 96, 183, 251,  63, 208,  46,  46]

Anchor arg encoding is plain Borsh:
    String  = u32_le(len) + utf8 bytes
    Pubkey  = 32 raw bytes

Account ordering must match the IDL exactly.
"""
from __future__ import annotations

import logging
import os
import struct
import time
from dataclasses import dataclass

from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.message import Message
from solders.pubkey import Pubkey
from solders.system_program import ID as SYS_PROGRAM_ID
from solders.transaction import Transaction

from solana.rpc.api import Client
from solana.rpc.commitment import Confirmed

from .oracle import RPC_URL, oracle_keypair

log = logging.getLogger(__name__)

# Set after `anchor deploy` (mirrors PROGRAM_ID in frontend/Host.tsx).
PROGRAM_ID = Pubkey.from_string(
    os.getenv("PROGRAM_ID", "2eMwChdNVoxeoWjdaiTuBGasDiHCKN3jbw7dL5eSyuZf")
)
# Must match the treasury Host.tsx baked into create_match — settle enforces it.
TREASURY_PUBKEY = Pubkey.from_string(
    os.getenv("TREASURY_PUBKEY", "2KnfMtidoDSVYxJDBNEK1e77rVQijvJ71zkBgz6kwejm")
)

SETTLE_DISCRIMINATOR = bytes([175, 42, 185, 87, 144, 131, 102, 212])
REFUND_DISCRIMINATOR = bytes([2, 96, 183, 251, 63, 208, 46, 46])

CONFIRM_TIMEOUT_S = 30


# ─── Borsh helpers ────────────────────────────────────────────────────────────


def _enc_string(s: str) -> bytes:
    raw = s.encode("utf-8")
    return struct.pack("<I", len(raw)) + raw


def _enc_pubkey(p: Pubkey) -> bytes:
    return bytes(p)


# ─── PDAs ─────────────────────────────────────────────────────────────────────


def match_pda(match_id: str) -> Pubkey:
    pda, _ = Pubkey.find_program_address([b"match", match_id.encode()], PROGRAM_ID)
    return pda


def vault_pda(match_id: str) -> Pubkey:
    pda, _ = Pubkey.find_program_address([b"vault", match_id.encode()], PROGRAM_ID)
    return pda


# ─── Instruction builders ─────────────────────────────────────────────────────


def _settle_ix(match_id: str, winner: Pubkey, oracle: Pubkey) -> Instruction:
    data = SETTLE_DISCRIMINATOR + _enc_string(match_id) + _enc_pubkey(winner)
    accounts = [
        AccountMeta(pubkey=oracle, is_signer=True, is_writable=True),
        AccountMeta(pubkey=match_pda(match_id), is_signer=False, is_writable=True),
        AccountMeta(pubkey=vault_pda(match_id), is_signer=False, is_writable=True),
        AccountMeta(pubkey=winner, is_signer=False, is_writable=True),
        AccountMeta(pubkey=TREASURY_PUBKEY, is_signer=False, is_writable=True),
        AccountMeta(pubkey=SYS_PROGRAM_ID, is_signer=False, is_writable=False),
    ]
    return Instruction(program_id=PROGRAM_ID, accounts=accounts, data=data)


def _refund_ix(match_id: str, p1: Pubkey, p2: Pubkey, oracle: Pubkey) -> Instruction:
    data = REFUND_DISCRIMINATOR + _enc_string(match_id)
    accounts = [
        AccountMeta(pubkey=oracle, is_signer=True, is_writable=True),
        AccountMeta(pubkey=match_pda(match_id), is_signer=False, is_writable=True),
        AccountMeta(pubkey=vault_pda(match_id), is_signer=False, is_writable=True),
        AccountMeta(pubkey=p1, is_signer=False, is_writable=True),
        AccountMeta(pubkey=p2, is_signer=False, is_writable=True),
        AccountMeta(pubkey=SYS_PROGRAM_ID, is_signer=False, is_writable=False),
    ]
    return Instruction(program_id=PROGRAM_ID, accounts=accounts, data=data)


# ─── Public API ───────────────────────────────────────────────────────────────


@dataclass
class SettleResult:
    signature: str
    explorer_url: str


def _client() -> Client:
    return Client(RPC_URL)


def _send_and_confirm(client: Client, ix: Instruction) -> str:
    oracle_kp = oracle_keypair()
    blockhash_resp = client.get_latest_blockhash(commitment=Confirmed)
    blockhash: Hash = blockhash_resp.value.blockhash

    msg = Message.new_with_blockhash([ix], oracle_kp.pubkey(), blockhash)
    tx = Transaction([oracle_kp], msg, blockhash)

    sig = client.send_raw_transaction(bytes(tx)).value

    # Block until confirmed or we hit the timeout — the caller wants a real tx.
    deadline = time.time() + CONFIRM_TIMEOUT_S
    while time.time() < deadline:
        status = client.get_signature_statuses([sig]).value[0]
        if status is not None and status.confirmation_status is not None:
            conf = str(status.confirmation_status)
            if "Confirmed" in conf or "Finalized" in conf or conf.endswith("confirmed") or conf.endswith("finalized"):
                if status.err is not None:
                    raise RuntimeError(f"settle tx failed: {status.err}")
                return str(sig)
        time.sleep(1)
    raise TimeoutError(f"tx {sig} not confirmed within {CONFIRM_TIMEOUT_S}s")


def settle(match_id: str, winner_pubkey: str) -> SettleResult:
    """Sign + send `settle(match_id, winner)` from the backend oracle. Blocks until
    the tx is confirmed. Caller should wrap in asyncio.to_thread.
    """
    winner = Pubkey.from_string(winner_pubkey)
    ix = _settle_ix(match_id, winner, oracle_keypair().pubkey())
    sig = _send_and_confirm(_client(), ix)
    return SettleResult(signature=sig, explorer_url=_explorer(sig))


def refund(match_id: str, p1_pubkey: str, p2_pubkey: str) -> SettleResult:
    p1 = Pubkey.from_string(p1_pubkey)
    p2 = Pubkey.from_string(p2_pubkey)
    ix = _refund_ix(match_id, p1, p2, oracle_keypair().pubkey())
    sig = _send_and_confirm(_client(), ix)
    return SettleResult(signature=sig, explorer_url=_explorer(sig))


def _explorer(sig: str) -> str:
    cluster = "devnet" if "devnet" in RPC_URL else "mainnet-beta"
    return f"https://explorer.solana.com/tx/{sig}?cluster={cluster}"
