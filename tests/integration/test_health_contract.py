import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from importers.health_contract import (  # noqa: E402
    CONTRACT_VERSION,
    normalize_health_entry,
    project_health_entries,
)


def _load(name):
    return json.loads((ROOT / "tests" / "fixtures" / name).read_text())


def test_dataset_projects_to_golden():
    dataset = _load("health_contract_dataset.json")
    golden = _load("health_contract_golden.json")
    assert project_health_entries(dataset) == golden


def test_golden_identities_stable_and_versioned():
    golden = _load("health_contract_golden.json")
    assert [g["identity"] for g in golden] == sorted(g["identity"] for g in golden)
    assert all(g["contract_version"] == CONTRACT_VERSION for g in golden)
    assert all(g["raw_content"]["untrusted"] is True for g in golden)


def test_alias_normalization_is_idempotent():
    record = _load("health_contract_dataset.json")[2]  # bodyComp + weight alias
    once = normalize_health_entry(record)
    twice = normalize_health_entry(once)
    # Campos semânticos estáveis após a primeira passada.
    for field in ("identity", "entry_type", "timestamp", "value", "contract_version"):
        assert twice[field] == once[field], field
    # raw_content é provenance da chamada: segunda chamada encapsula o output da primeira.
    assert twice["raw_content"]["value"] == once


def test_conflicting_duplicate_identity_rejected():
    dataset = _load("health_contract_dataset.json")
    clash = dict(dataset[0])
    clash["value"] = {"steps": 999}
    try:
        project_health_entries(dataset + [clash])
    except ValueError as exc:
        assert "conflicting duplicate identity" in str(exc)
    else:
        raise AssertionError("conflicting duplicate identity accepted")


def test_invalid_entries_rejected():
    bad = [
        {"entry_type": "telepathy", "timestamp": "2026-09-10T00:00:00Z"},
        {"entry_type": "steps", "timestamp": "no-offset", "value": {"count": 1}},
        {"entry_type": "steps", "timestamp": "2026-09-10T00:00:00Z", "value": {"count": -5}},
        {"entry_type": "weight", "timestamp": "2026-09-10T00:00:00Z", "value": {"weight": "x"}},
        {"entry_type": "steps", "timestamp": "2026-09-10T00:00:00Z", "value": {"count": 1}, "source": 1},
    ]
    for record in bad:
        try:
            normalize_health_entry(record)
        except (ValueError, TypeError):
            continue
        raise AssertionError(f"invalid entry accepted: {record}")
