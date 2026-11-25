import json
from pathlib import Path
from typing import Any


def build_cases_jsonl(src_dir: Path, out_path: Path) -> int:
    rows: list[dict[str, Any]] = []

    # 1. material_cases.json -> extract
    mat_file = src_dir / "material_cases.json"
    if mat_file.exists():
        data = json.loads(mat_file.read_text(encoding="utf-8"))
        for c in data.get("cases", []):
            rows.append({
                "id": c["id"],
                "task": "extract",
                "is_core": True,
                "expected": c.get("expected", ""),
                "criteria": c.get("criteria", []),
                "payload": {
                    "record_text": c["input"],
                },
            })

    # 2. question_cases.json -> qna_next / qna_alt
    q_file = src_dir / "question_cases.json"
    if q_file.exists():
        data = json.loads(q_file.read_text(encoding="utf-8"))
        for c in data.get("cases", []):
            rejected = c.get("rejected_questions") or []
            task = "qna_alt" if len(rejected) > 0 else "qna_next"
            payload: dict[str, Any] = {
                "chat_history": c["chat_history"],
            }
            if task == "qna_alt":
                payload["rejected_questions"] = rejected
            rows.append({
                "id": c["id"],
                "task": task,
                "is_core": True,
                "expected": c.get("expected", ""),
                "criteria": c.get("criteria", []),
                "payload": payload,
            })

    # 3. essay_cases.json -> draft
    e_file = src_dir / "essay_cases.json"
    if e_file.exists():
        data = json.loads(e_file.read_text(encoding="utf-8"))
        for c in data.get("cases", []):
            direction = (c.get("direction") or "").strip()
            user_req = f"글의 방향: {direction}" if direction else ""
            rows.append({
                "id": c["id"],
                "task": "draft",
                "is_core": True,
                "expected": c.get("expected", ""),
                "criteria": c.get("criteria", []),
                "payload": {
                    "materials": c["materials"],
                    "tone": c.get("tone", "담백함"),
                    "length": c.get("length", "단문"),
                    "user_request": user_req,
                },
            })

    # 4. retouch_cases.json -> retouch
    r_file = src_dir / "retouch_cases.json"
    if r_file.exists():
        data = json.loads(r_file.read_text(encoding="utf-8"))
        for c in data.get("cases", []):
            rows.append({
                "id": c["id"],
                "task": "retouch",
                "is_core": True,
                "expected": c.get("expected", ""),
                "criteria": c.get("criteria", []),
                "payload": {
                    "current_draft": c["current_draft"],
                    "selected_materials": c["selected_materials"],
                    "tone": c.get("tone", "담백함"),
                    "length": c.get("length", "단문"),
                    "user_request": "",
                },
            })

    # 5. proposal_cases.json -> proposal
    p_file = src_dir / "proposal_cases.json"
    if p_file.exists():
        data = json.loads(p_file.read_text(encoding="utf-8"))
        for c in data.get("cases", []):
            rows.append({
                "id": c["id"],
                "task": "proposal",
                "is_core": True,
                "expected": c.get("expected", ""),
                "criteria": c.get("criteria", []),
                "payload": {
                    "materials": c["materials"],
                },
            })

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    return len(rows)


if __name__ == "__main__":
    total = build_cases_jsonl(Path("."), Path("cases.jsonl"))
    print(f"cases.jsonl 생성 완료: 총 {total}개 케이스")