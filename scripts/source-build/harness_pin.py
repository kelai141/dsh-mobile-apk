#!/usr/bin/env python3
"""Read the single pinned Harness identity from scripts/contract.json."""
from __future__ import annotations

import json
import pathlib
import re
from typing import NamedTuple

CONTRACT_PATH = pathlib.Path(__file__).resolve().parents[1] / "contract.json"
_COMMIT = re.compile(r"^[0-9a-f]{40}$")
_VERSION = re.compile(r"^\d+\.\d+\.\d+-rc\.\d+$")
_PACKAGE_MANAGER = re.compile(r"^pnpm@\d+\.\d+\.\d+$")


class HarnessIdentity(NamedTuple):
    commit: str
    version: str
    package_manager: str
    engines_node: str


def read_harness_identity(contract_path: pathlib.Path | None = None) -> HarnessIdentity:
    contract = json.loads(
        pathlib.Path(contract_path or CONTRACT_PATH).read_text(encoding="utf-8")
    )
    upstream = contract.get("upstream") or {}
    commit = upstream.get("commit")
    version = contract.get("baseline")
    package_manager = upstream.get("packageManager")
    engines_node = upstream.get("enginesNode")
    if not isinstance(commit, str) or not _COMMIT.fullmatch(commit):
        raise ValueError("contract.upstream.commit must be a full lowercase Git commit")
    if not isinstance(version, str) or not _VERSION.fullmatch(version):
        raise ValueError("contract.baseline must be an exact -rc release version")
    if upstream.get("rootVersion") != version:
        raise ValueError(
            f"contract baseline {version} disagrees with upstream.rootVersion "
            f"{upstream.get('rootVersion')}"
        )
    if not isinstance(package_manager, str) or not _PACKAGE_MANAGER.fullmatch(package_manager):
        raise ValueError("contract.upstream.packageManager must be an exact pnpm version")
    if not isinstance(engines_node, str) or not engines_node.strip():
        raise ValueError("contract.upstream.enginesNode must be declared")
    return HarnessIdentity(commit, version, package_manager, engines_node)
