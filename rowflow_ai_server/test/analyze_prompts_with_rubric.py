import argparse
import csv
import json
import os
import re
import statistics
import time
from collections import defaultdict
from datetime import datetime
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any
from urllib import error, request


# ==========================================
# 1. 토큰 단가 설정 (1M 토큰당 USD 기준)
# ==========================================
DEFAULT_PRICING_PER_1M = {
    "default": {"input": 2.0, "output": 10.0},
    "logic": {
        "input": float(os.getenv("LOGIC_INPUT_PRICE_PER_1M", os.getenv("INPUT_PRICE_PER_1M", "2.5"))),
        "output": float(os.getenv("LOGIC_OUTPUT_PRICE_PER_1M", os.getenv("OUTPUT_PRICE_PER_1M", "10.0"))),
    },
    "essay": {
        "input": float(os.getenv("ESSAY_INPUT_PRICE_PER_1M", os.getenv("INPUT_PRICE_PER_1M", "3.0"))),
        "output": float(os.getenv("ESSAY_OUTPUT_PRICE_PER_1M", os.getenv("OUTPUT_PRICE_PER_1M", "15.0"))),
    },
}


def estimate_cost_usd(input_tokens: int, output_tokens: int, route_group: str = "default") -> float:
    rates = DEFAULT_PRICING_PER_1M.get(route_group, DEFAULT_PRICING_PER_1M["default"])
    in_cost = (max(0, input_tokens) / 1_000_000) * rates["input"]
    out_cost = (max(0, output_tokens) / 1_000_000) * rates["output"]
    return round(in_cost + out_cost, 6)


def percentile(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    idx = (len(sorted_vals) - 1) * p
    low = int(idx)
    high = min(low + 1, len(sorted_vals) - 1)
    frac = idx - low
    return round(sorted_vals[low] * (1 - frac) + sorted_vals[high] * frac, 3)


# ==========================================
# 2. HTTP 호출 및 자동 규칙 검증
# ==========================================
ENDPOINT_MAP = {
    "extract": ("/api/material/extract", "logic"),
    "qna_next": ("/api/qna/next", "logic"),
    "qna_alt": ("/api/qna/alternative", "logic"),
    "draft": ("/api/essay/draft", "essay"),
    "retouch": ("/api/essay/retouch", "essay"),
    "proposal": ("/api/proposal/recommend", "logic"),
}


def post_json(url: str, payload: dict[str, Any], timeout: float = 120.0) -> tuple[dict[str, Any], float]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = request.Request(
        url=url,
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    t0 = time.perf_counter()
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            raw_text = resp.read().decode("utf-8")
    except error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {err_body}") from e
    except Exception as e:
        raise RuntimeError(f"요청 실패: {e}") from e
    elapsed = round(time.perf_counter() - t0, 3)
    return json.loads(raw_text), elapsed


def get_length_range(length_label: str) -> tuple[int, int]:
    norm = (length_label or "").strip()
    if "장문" in norm or "길게" in norm:
        return 1000, 1500
    return 300, 500


def text_similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return round(SequenceMatcher(None, a.strip(), b.strip()).ratio(), 4)


def extract_main_output_text(task: str, response_data: dict[str, Any]) -> str:
    if task == "draft":
        val = response_data.get("essay_content")
        return val if isinstance(val, str) else ""
    if task == "retouch":
        val = response_data.get("retouched_content")
        return val if isinstance(val, str) else ""
    if task in ("qna_next", "qna_alt"):
        val = response_data.get("next_question")
        return val if isinstance(val, str) else ""
    return json.dumps(
        {k: v for k, v in response_data.items() if k not in ("input_tokens", "output_tokens", "latency_sec")},
        ensure_ascii=False,
    )


def evaluate_case_schema_and_rules(task: str, case: dict[str, Any], response_data: dict[str, Any]) -> dict[str, Any]:
    checks: dict[str, Any] = {"schema_valid": False, "notes": []}
    payload = case.get("payload", {})

    if task == "extract":
        required = ["title", "summary", "keywords", "topic_ids", "evidence"]
        has_keys = all(k in response_data for k in required)
        topics = response_data.get("topic_ids") or []
        topic_ok = isinstance(topics, list) and 1 <= len(topics) <= 2
        checks["schema_valid"] = bool(has_keys and topic_ok)
        if not has_keys:
            checks["notes"].append("필수 키 누락")
        if not topic_ok:
            checks["notes"].append(f"topic_ids 개수 이상({len(topics) if isinstance(topics, list) else 'non-list'})")

    elif task in ("qna_next", "qna_alt"):
        q = response_data.get("next_question")
        is_str = isinstance(q, str) and len(q.strip()) > 0
        q_marks = q.count("?") if isinstance(q, str) else 0
        checks["schema_valid"] = bool(is_str and q_marks == 1)
        checks["question_mark_count"] = q_marks
        if not is_str:
            checks["notes"].append("next_question 누락/공백")
        elif q_marks != 1:
            checks["notes"].append(f"물음표 개수={q_marks} (단일 질문 기준 1개 권장)")

    elif task in ("draft", "retouch"):
        content_key = "essay_content" if task == "draft" else "retouched_content"
        text = response_data.get(content_key)
        is_str = isinstance(text, str) and len(text.strip()) > 0
        min_c, max_c = get_length_range(str(payload.get("length", "단문")))
        char_len = len(text) if isinstance(text, str) else 0
        in_range = bool(is_str and min_c <= char_len <= max_c)

        source_ref = (
            str(payload.get("materials", ""))
            if task == "draft"
            else f"{payload.get('current_draft', '')}\n{payload.get('selected_materials', '')}"
        )
        sim = text_similarity(text or "", source_ref)

        sents = [s.strip() for s in re.split(r"[.!?。]+", text or "") if len(s.strip()) >= 8]
        unique_ratio = round(len(set(sents)) / len(sents), 4) if sents else 1.0

        checks["schema_valid"] = bool(is_str)
        checks["char_len"] = char_len
        checks["target_range"] = f"{min_c}-{max_c}"
        checks["length_ok"] = in_range
        checks["source_similarity"] = sim
        checks["unique_sentence_ratio"] = unique_ratio

        if not is_str:
            checks["notes"].append(f"{content_key} 누락")
        if not in_range:
            checks["notes"].append(f"분량 범위 이탈({char_len}자, 목표 {min_c}~{max_c}자)")
        if sim >= 0.85:
            checks["notes"].append(f"원문과 유사도 높음({sim}) - 단순 복붙 주의")
        if unique_ratio < 0.8:
            checks["notes"].append(f"문장 중복 비율 높음(고유율 {unique_ratio})")

    elif task == "proposal":
        can_suggest = response_data.get("can_suggest")
        is_bool = isinstance(can_suggest, bool)
        if can_suggest is False:
            null_ok = (
                response_data.get("title") is None
                and response_data.get("reason") is None
                and response_data.get("direction") is None
            )
            checks["schema_valid"] = bool(is_bool and null_ok)
            if not null_ok:
                checks["notes"].append("can_suggest=false인데 null이 아닌 필드 존재")
        elif can_suggest is True:
            filled_ok = all(
                isinstance(response_data.get(k), str) and len(response_data.get(k).strip()) > 0
                for k in ("title", "reason", "direction")
            )
            checks["schema_valid"] = bool(is_bool and filled_ok)
            if not filled_ok:
                checks["notes"].append("can_suggest=true인데 title/reason/direction 누락")
        else:
            checks["schema_valid"] = False
            checks["notes"].append("can_suggest가 bool이 아님")

    return checks


# ==========================================
# 3. 정성/루브릭 관리 (원문 왜곡 여부 + 문장 자연스러움)
# ==========================================
def load_rubric_map(rubric_path: str | None) -> dict[tuple[str, str], dict[str, Any]]:
    """
    루브릭 파일을 (version, case_id) 키로 로드.
    지원 형식: JSONL 또는 {"items": [...]} / [...] / {...} 형태 JSON
    필드 예시:
      - distortion_free: bool (True=원문 왜곡 없음/통과, False=왜곡/환각/반전 발생)
      - naturalness_score: int (1~5, 3 이상을 자연스러움 통과 기준으로 집계)
      - rubric_note: str
    """
    mapping: dict[tuple[str, str], dict[str, Any]] = {}
    if not rubric_path:
        return mapping
    p = Path(rubric_path)
    if not p.exists():
        return mapping

    raw = p.read_text(encoding="utf-8").strip()
    if not raw:
        return mapping

    items: list[dict[str, Any]] = []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            items = parsed
        elif isinstance(parsed, dict) and isinstance(parsed.get("items"), list):
            items = parsed["items"]
        elif isinstance(parsed, dict):
            items = [parsed]
    except json.JSONDecodeError:
        for line in raw.splitlines():
            if line.strip():
                items.append(json.loads(line))

    for it in items:
        ver = str(it.get("version", ""))
        cid = str(it.get("case_id", ""))
        if ver and cid:
            mapping[(ver, cid)] = it
    return mapping


def prompt_interactive_rubric(
    records: list[dict[str, Any]],
    rubric_map: dict[tuple[str, str], dict[str, Any]],
    core_only: bool = True,
) -> dict[tuple[str, str], dict[str, Any]]:
    """핵심 케이스(E01~E08 등 is_core=True)에 대해 원문 왜곡 여부와 문장 자연스러움을 입력"""
    target_records = [r for r in records if (not core_only or r.get("is_core"))]
    if not target_records:
        print("\n[루브릭 입력] 대상 핵심 케이스(is_core=True)가 없습니다.")
        return rubric_map

    print("\n" + "=" * 96)
    print("핵심 케이스 정성/루브릭 체크 (원문 왜곡 여부 / 문장 자연스러움 1~5점)")
    print("엔터만 누르면 기존 값 유지 또는 미입력(None)으로 넘어갑니다. 'q' 입력 시 종료.")
    print("=" * 96)

    for rec in target_records:
        key = (rec["version"], rec["case_id"])
        existing = rubric_map.get(key, {})
        print(f"\n▶ [{rec['version']}] {rec['case_id']} ({rec['task']}) | 자동분량={rec.get('length_ok')} | 글자수={rec.get('char_len')}")
        print(f"   원문/입력: {rec.get('source_preview', '')}")
        print(f"   생성결과: {rec.get('output_text', '')}")
        if existing:
            print(
                f"   (기존 루브릭: 왜곡없음={existing.get('distortion_free')}, "
                f"자연스러움={existing.get('naturalness_score')}, 메모={existing.get('rubric_note', '')})"
            )

        # 1. 원문 왜곡 여부 (y=왜곡 없음/통과, n=왜곡/환각/부정반전 발생)
        cur_df = existing.get("distortion_free")
        raw_df = input("   원문 왜곡 없음? [y=통과 / n=왜곡발생 / Enter=유지, q=중단]: ").strip().lower()
        if raw_df == "q":
            break
        if raw_df in ("y", "yes", "true", "1", "o"):
            distortion_free: bool | None = True
        elif raw_df in ("n", "no", "false", "0", "x"):
            distortion_free = False
        elif raw_df == "":
            distortion_free = cur_df if isinstance(cur_df, bool) else None
        else:
            distortion_free = cur_df if isinstance(cur_df, bool) else None

        # 2. 문장 자연스러움 (1~5점)
        cur_nat = existing.get("naturalness_score")
        raw_nat = input("   문장 자연스러움 [1~5점 / Enter=유지]: ").strip()
        if raw_nat == "":
            naturalness_score: int | None = cur_nat if isinstance(cur_nat, int) else None
        else:
            try:
                val = int(raw_nat)
                naturalness_score = val if 1 <= val <= 5 else (cur_nat if isinstance(cur_nat, int) else None)
            except ValueError:
                naturalness_score = cur_nat if isinstance(cur_nat, int) else None

        # 3. 메모
        cur_note = existing.get("rubric_note", "")
        raw_note = input(f"   메모 [현재: {cur_note} / Enter=유지]: ").strip()
        rubric_note = raw_note if raw_note != "" else cur_note

        rubric_map[key] = {
            "version": rec["version"],
            "case_id": rec["case_id"],
            "task": rec["task"],
            "distortion_free": distortion_free,
            "naturalness_score": naturalness_score,
            "naturalness_pass": (naturalness_score >= 3) if isinstance(naturalness_score, int) else None,
            "rubric_note": rubric_note,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }

    return rubric_map


def save_rubric_map(rubric_map: dict[tuple[str, str], dict[str, Any]], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        for _, item in sorted(rubric_map.items()):
            f.write(json.dumps(item, ensure_ascii=False) + "\n")


# ==========================================
# 4. 샘플 케이스 (E01~E08 등 실제 케이스 JSONL로 교체 권장)
# ==========================================
SAMPLE_CASES = [
    {
        "id": "E01",
        "task": "draft",
        "is_core": True,
        "payload": {
            "materials": [
                "혼자 식당에 갔다. 직원이 창가와 안쪽 중 어디에 앉겠느냐고 물었다.",
                "평소에는 다른 사람이 고른 자리에 앉는 편이었는데 그날은 창가를 골랐다.",
                "음식이 나올 때까지 지나가는 사람들을 보았고 다음에도 자리를 직접 골라보고 싶었다.",
            ],
            "tone": "감성",
            "length": "단문",
            "user_request": "",
        },
    },
    {
        "id": "E02",
        "task": "retouch",
        "is_core": True,
        "payload": {
            "current_draft": "처음 키운 토마토가 익었다. 따서 바로 먹어보았다. 껍질은 생각보다 질겼다. 하지만 맛보다 먼저 떠오른 건 매일 물을 주고 상태를 살펴보던 시간이었다.",
            "selected_materials": "베란다에서 키운 토마토가 익어 따 먹었고 껍질이 질겼으며 키우던 시간이 떠올랐다.",
            "tone": "감성",
            "length": "단문",
            "user_request": "여운을 살려 다듬어줘",
        },
    },
    {
        "id": "E03",
        "task": "extract",
        "is_core": True,
        "payload": {
            "record_text": "퇴근길 버스에서 내려 집으로 걸어가는데 골목 끝 오래된 세탁소 불빛이 보였다. 사장님과 짧게 목례만 하고 지나쳤다."
        },
    },
    {
        "id": "E04",
        "task": "qna_next",
        "is_core": True,
        "payload": {
            "chat_history": [
                {"role": "user", "content": "주말 아침에 처음으로 직접 반죽해서 식빵을 구웠어."}
            ]
        },
    },
    {
        "id": "E05",
        "task": "proposal",
        "is_core": True,
        "payload": {
            "materials": [
                "은행 비밀번호를 변경했다.",
                "냉동 만두를 데워 먹었다.",
                "복도에서 떨어진 충전선을 주웠다.",
            ]
        },
    },
]


def load_cases(cases_path: str | None) -> list[dict[str, Any]]:
    if not cases_path:
        return SAMPLE_CASES
    p = Path(cases_path)
    cases: list[dict[str, Any]] = []
    with p.open("r", encoding="utf-8") as f:
        for idx, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            item.setdefault("id", f"CASE_{idx:03d}")
            item.setdefault("is_core", item["id"] in {f"E{i:02d}" for i in range(1, 21)})
            cases.append(item)
    return cases


# ==========================================
# 5. 실행, 병합 및 비교 리포트
# ==========================================
def run_experiment(base_url: str, version_tag: str, cases: list[dict[str, Any]]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for case in cases:
        task = case["task"]
        if task not in ENDPOINT_MAP:
            raise ValueError(f"지원하지 않는 task입니다: {task}")
        endpoint_path, route_group = ENDPOINT_MAP[task]
        url = base_url.rstrip("/") + endpoint_path

        status = "ok"
        error_msg = ""
        res_data: dict[str, Any] = {}
        fallback_latency = 0.0

        try:
            res_data, fallback_latency = post_json(url, case["payload"])
        except Exception as e:
            status = "error"
            error_msg = str(e)

        in_tok = int(res_data.get("input_tokens", 0) or 0)
        out_tok = int(res_data.get("output_tokens", 0) or 0)
        latency = float(res_data.get("latency_sec", fallback_latency) or fallback_latency)
        cost_usd = estimate_cost_usd(in_tok, out_tok, route_group=route_group)
        checks = evaluate_case_schema_and_rules(task, case, res_data) if status == "ok" else {"schema_valid": False, "notes": [error_msg]}

        payload = case.get("payload", {})
        source_preview = str(
            payload.get("record_text")
            or payload.get("materials")
            or payload.get("current_draft")
            or payload.get("chat_history")
            or ""
        ).replace("\n", " ")[:140]

        output_text = extract_main_output_text(task, res_data) if status == "ok" else error_msg

        rec = {
            "version": version_tag,
            "case_id": case["id"],
            "task": task,
            "is_core": bool(case.get("is_core", False)),
            "route_group": route_group,
            "status": status,
            "schema_valid": checks.get("schema_valid", False),
            "length_ok": checks.get("length_ok"),
            "char_len": checks.get("char_len"),
            "source_similarity": checks.get("source_similarity"),
            "unique_sentence_ratio": checks.get("unique_sentence_ratio"),
            "input_tokens": in_tok,
            "output_tokens": out_tok,
            "total_tokens": in_tok + out_tok,
            "cost_usd": cost_usd,
            "latency_sec": latency,
            "auto_notes": " | ".join(checks.get("notes", [])),
            "source_preview": source_preview,
            "output_text": output_text,
            "error": error_msg,
        }
        records.append(rec)
        print(
            f"[{version_tag}] {case['id']} ({task}) core={rec['is_core']} -> "
            f"schema={rec['schema_valid']}, len_ok={rec['length_ok']}, "
            f"lat={latency:.3f}s, tok={in_tok}+{out_tok}, cost=${cost_usd:.6f}"
        )
    return records


def attach_rubric(records: list[dict[str, Any]], rubric_map: dict[tuple[str, str], dict[str, Any]]) -> list[dict[str, Any]]:
    merged_rows: list[dict[str, Any]] = []
    for r in records:
        rub = rubric_map.get((r["version"], r["case_id"]), {})
        df = rub.get("distortion_free")
        nat = rub.get("naturalness_score")
        nat_pass = (nat >= 3) if isinstance(nat, int) else None
        note = rub.get("rubric_note", "")

        row = dict(r)
        row["distortion_free"] = df
        row["naturalness_score"] = nat
        row["naturalness_pass"] = nat_pass
        row["rubric_note"] = note
        merged_rows.append(row)
    return merged_rows


def print_side_by_side_report(rows: list[dict[str, Any]]) -> None:
    by_ver: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        by_ver[r["version"]].append(r)

    print("\n" + "=" * 112)
    print("케이스별 자동 지표 + 정성/루브릭 나란히 보기")
    print("=" * 112)
    for r in rows:
        df_str = "PASS" if r["distortion_free"] is True else ("FAIL" if r["distortion_free"] is False else "-")
        nat_str = f"{r['naturalness_score']}/5" if isinstance(r["naturalness_score"], int) else "-"
        len_str = "-" if r["length_ok"] is None else ("OK" if r["length_ok"] else f"NG({r['char_len']}자)")
        print(
            f"[{r['version']}] {r['case_id']} ({r['task']:<8}) | "
            f"자동: schema={str(r['schema_valid']):<5} len={len_str:<10} lat={r['latency_sec']:>6.3f}s tok={r['total_tokens']:>4} | "
            f"루브릭: 왜곡없음={df_str:<4} 자연스러움={nat_str:<4} | 메모: {r['rubric_note']}"
        )

    print("\n" + "=" * 112)
    print("버전별 종합 요약 (자동 지표 + 핵심 케이스 루브릭)")
    print("=" * 112)
    for ver, vrows in sorted(by_ver.items()):
        n = len(vrows)
        lats = [float(x["latency_sec"]) for x in vrows]
        cost_sum = round(sum(float(x["cost_usd"]) for x in vrows), 6)

        len_targets = [x for x in vrows if x["length_ok"] is not None]
        len_pass = sum(1 for x in len_targets if x["length_ok"] is True)
        len_rate = f"{len_pass}/{len(len_targets)}" if len_targets else "-"

        core_rows = [x for x in vrows if x.get("is_core")]
        df_checked = [x for x in core_rows if isinstance(x.get("distortion_free"), bool)]
        df_pass = sum(1 for x in df_checked if x["distortion_free"] is True)
        df_rate = f"{df_pass}/{len(df_checked)}" if df_checked else "-"

        nat_checked = [x for x in core_rows if isinstance(x.get("naturalness_score"), int)]
        nat_avg = round(statistics.mean([x["naturalness_score"] for x in nat_checked]), 2) if nat_checked else 0.0
        nat_str = f"{nat_avg}/5 ({len(nat_checked)}건)" if nat_checked else "-"

        print(
            f"- {ver}: 총 {n}건 | 스키마 {sum(1 for x in vrows if x['schema_valid'])}/{n} | "
            f"분량준수 {len_rate} | 핵심 원문왜곡없음 {df_rate} | 핵심 자연스러움 {nat_str} | "
            f"평균지연 {statistics.mean(lats):.3f}s | 총비용 ${cost_sum:.6f}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(description="자동 지표 + 핵심 케이스 정성/루브릭 병합 분석기")
    parser.add_argument("--base-url", default="http://127.0.0.1:8000", help="FastAPI 서버 주소")
    parser.add_argument("--tag", default="v1_new_prompt", help="현재 실험 버전 태그")
    parser.add_argument("--cases", default=None, help="테스트 케이스 JSONL 파일 경로")
    parser.add_argument("--rubric-file", default="eval_analysis/rubric_scores.jsonl", help="정성/루브릭 저장·불러오기 파일")
    parser.add_argument("--rubric-interactive", action="store_true", help="실행 후 핵심 케이스 루브릭 직접 입력")
    parser.add_argument("--all-cases-rubric", action="store_true", help="핵심 케이스(is_core)뿐 아니라 전체 케이스 루브릭 입력")
    parser.add_argument("--compare-records", nargs="*", default=None, help="기존 저장된 merged_*.jsonl 파일들을 함께 불러와 비교")
    parser.add_argument("--out-dir", default="eval_analysis", help="결과 저장 폴더")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    rubric_path = Path(args.rubric_file)
    rubric_map = load_rubric_map(str(rubric_path))

    all_records: list[dict[str, Any]] = []
    if args.compare_records:
        for fp in args.compare_records:
            with Path(fp).open("r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        all_records.append(json.loads(line))

    cases = load_cases(args.cases)
    current_records = run_experiment(args.base_url, args.tag, cases)

    if args.rubric_interactive:
        rubric_map = prompt_interactive_rubric(
            current_records,
            rubric_map,
            core_only=not args.all_cases_rubric,
        )
        save_rubric_map(rubric_map, rubric_path)
        print(f"\n루브릭 저장 완료: {rubric_path}")

    current_merged = attach_rubric(current_records, rubric_map)
    all_records.extend(current_merged)

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    merged_jsonl = out_dir / f"merged_{args.tag}_{ts}.jsonl"
    with merged_jsonl.open("w", encoding="utf-8") as f:
        for row in current_merged:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print_side_by_side_report(all_records)

    summary_csv = out_dir / f"merged_summary_{ts}.csv"
    with summary_csv.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=list(all_records[0].keys()))
        writer.writeheader()
        writer.writerows(all_records)

    print(f"\n케이스별 병합 JSONL 저장 완료: {merged_jsonl}")
    print(f"전체 비교 CSV 저장 완료: {summary_csv}")


if __name__ == "__main__":
    main()