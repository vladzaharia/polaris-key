# @pkey-feature core.devicekeys
"""``conformance/corpus/v2/device-proof.json`` (WIRE-CONTRACT-V5 §12.11.1, §15.8) through the Python
verifier, and every valid purpose signed through the key store (CC-26.3).

Mirrors ``conformance/runners/node/deviceProof.test.ts``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from polaris_key.core.b64url import b64url_decode
from polaris_key.core.device_keys import (
    DeviceProofError,
    sign_device_proof,
    sign_keys_proof,
)
from polaris_key.core.device_proof import (
    DEVICE_PROOF_PURPOSES,
    DeviceProof,
    DeviceProofFields,
    device_proof_keys_value,
    device_proof_message,
    verify_device_proof,
)
from polaris_key.devices.keys import DeviceKeyStore, InMemoryDeviceKeyStorage

_CORPUS = json.loads(
    (Path(__file__).resolve().parents[3] / "conformance" / "corpus" / "v2" / "device-proof.json").read_text()
)
_ROWS: List[Dict[str, Any]] = _CORPUS["cases"]


def _proof(row: Dict[str, Any]) -> DeviceProof:
    return DeviceProof(
        purpose=row["purpose"],
        product=row["product"],
        device_id=row["deviceId"],
        value=row["value"],
        token_hash=row["tokenHash"],
        sign_key=row["signKey"],
        sig=row["sig"],
    )


def test_the_corpus_names_the_purposes_the_client_knows() -> None:
    assert _CORPUS["deviceProofVersion"] == 1
    assert _CORPUS["line1"] == "pkey-proof/1"
    assert _CORPUS["purposes"] == list(DEVICE_PROOF_PURPOSES)
    assert _CORPUS["skewSeconds"] == 300


def test_the_keys_value_is_built_from_its_parts() -> None:
    for c in _CORPUS["keyValueCases"]:
        assert device_proof_keys_value(c["signKey"], c["agreeKey"], c["issuedAt"]) == c["value"]


@pytest.mark.parametrize("row", _ROWS, ids=[r["id"] for r in _ROWS])
def test_every_row_has_the_message_and_the_verdict(row: Dict[str, Any]) -> None:
    proof = _proof(row)
    message = device_proof_message(proof)
    if row["messageHex"] is None:
        assert message is None
    else:
        assert message is not None and message.hex() == row["messageHex"]
    assert verify_device_proof(proof, now=row["now"]) is (row["verdict"] == "ok")


def test_the_corpus_has_a_valid_row_for_every_purpose() -> None:
    ok = {r["purpose"] for r in _ROWS if r["verdict"] == "ok"}
    assert ok == set(DEVICE_PROOF_PURPOSES)


_VALID = [r for r in _ROWS if r["verdict"] == "ok"]


@pytest.mark.parametrize("row", _VALID, ids=[r["id"] for r in _VALID])
def test_every_valid_row_signs_through_the_store_with_the_exact_message(row: Dict[str, Any]) -> None:
    store = DeviceKeyStore(InMemoryDeviceKeyStorage())
    keys = store.ensure()
    expected = bytes.fromhex(row["messageHex"])

    if row["purpose"] == "keys":
        # The value names the store's own keys, so the row's key bytes cannot be reused: rebuild the
        # message from the row's other fields and the store's keys and compare it line by line.
        proof, got_keys, issued_at = sign_keys_proof(
            store, product=row["product"], device_id=row["deviceId"], issued_at=row["now"], allow_ephemeral=True
        )
        value = f"{keys.sign_key}.{keys.agree_key}.{row['now']}"
        assert got_keys == keys and issued_at == row["now"]
        assert proof.value == value
        message = f"pkey-proof/1\nkeys\n{row['product']}\n{row['deviceId']}\n{value}\n-".encode("ascii")
        # The row's own message has the same shape: same lines but the key material.
        assert expected.decode("ascii").split("\n")[:4] == message.decode("ascii").split("\n")[:4]
        assert expected.decode("ascii").split("\n")[5] == "-"
    else:
        proof = sign_device_proof(
            store,
            purpose=row["purpose"],
            product=row["product"],
            device_id=row["deviceId"],
            value=row["value"],
            token_hash=row["tokenHash"],
            now=row["now"],
        )
        message = expected
        assert device_proof_message(proof) == expected

    assert proof.sign_key == keys.sign_key
    sig = b64url_decode(proof.sig)
    assert len(sig) == 64
    # The signature is over exactly those bytes, by exactly the store's signing key.
    Ed25519PublicKey.from_public_bytes(b64url_decode(keys.sign_key)).verify(sig, message)
    assert verify_device_proof(proof, now=row["now"])


def test_a_proof_for_the_keys_purpose_cannot_go_through_the_general_signer() -> None:
    store = DeviceKeyStore(InMemoryDeviceKeyStorage())
    with pytest.raises(DeviceProofError):
        sign_device_proof(store, purpose="keys", product="djdl", device_id="d", value="v")


def test_a_signature_for_another_purpose_does_not_verify() -> None:
    store = DeviceKeyStore(InMemoryDeviceKeyStorage())
    p = sign_device_proof(store, purpose="nonce", product="djdl", device_id="AAAA", value="abc")
    moved = DeviceProof(**{**p.__dict__, "purpose": "exchange"})
    assert verify_device_proof(p, now=1) and not verify_device_proof(moved, now=1)
    assert device_proof_message(DeviceProofFields("nonce", "djdl", "AAAA", "a b")) is None
