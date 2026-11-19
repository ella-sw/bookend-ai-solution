# -*- coding: utf-8 -*-
"""Rowflow 글쓰기 제안 S01~S08: 실제 API 응답 수집 + 기준별 LLM 예비 판정.

실행: python proposal_runner.py
필수: pip install requests openai python-dotenv
먼저 FastAPI 서버를 127.0.0.1:8000에서 실행하세요.
"""

import csv
import datetime as dt
import json
import os
from pathlib import Path
import sys

import requests
from dotenv import load_dotenv
from openai import OpenAI

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / '.env')
load_dotenv(HERE.parent / '.env')

BASE_URL = os.getenv('ROWFLOW_API_BASE_URL', 'http://127.0.0.1:8000').rstrip('/')
JUDGE_MODEL = os.getenv('ROWFLOW_JUDGE_MODEL', 'gpt-4o-mini')
COLS = [
    '사례 ID', '평가 대상', '평가 기준', '테스트 입력', '기대 동작',
    '실제 AI 응답', '평가 결과', '판단 근거', '개선 필요 사항',
]


def save_csv(path, records, columns):
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(records)


def validate_proposal_response(actual):
    """검증: 제안 생성(true)과 정상적인 제안 보류(false) 모두 허용."""
    if not isinstance(actual, dict):
        raise ValueError('API 응답이 JSON 객체가 아닙니다')

    can_suggest = actual.get('can_suggest')
    if not isinstance(can_suggest, bool):
        raise ValueError('can_suggest 필드가 없거나 boolean이 아닙니다')

    fields = ('title', 'reason', 'direction')
    if can_suggest is False:
        if any(actual.get(key) is not None for key in fields):
            raise ValueError('제안 보류 시 title/reason/direction은 null이어야 합니다')
    else:
        if any(
            not isinstance(actual.get(key), str) or not actual[key].strip()
            for key in fields
        ):
            raise ValueError('제안 생성 시 title/reason/direction에 내용이 있는 문자열이 필요합니다')


def prelim_judge(client, case, response, rubrics):
    criteria = [{'criterion': key, **rubrics[key]} for key in case['criteria']]
    payload = {
        'case_id': case['id'],
        'common_topic': case['topic'],
        'original_materials': case['materials'],
        'actual_response': response,
        'criteria': criteria,
    }
    instruction = '''당신은 Rowflow 글쓰기 제안의 한국어 품질 평가 보조자입니다.
한 사례에 지정된 두 평가 기준만 각각 독립적으로 판단하세요. 다른 평가 기준으로 대체하거나 추가하지 마세요.
원래 제공된 세 소재의 사실, 소재를 연결할 타당한 근거, 추천 이유(reason), 제목(title), 작성 방향(direction)을 모두 비교하세요.
제안이 사실로 단정한 사건·감정·관계·교훈이 제공 자료에 없는지 엄격히 살피세요.
소재 간 연결 타당성은 실제 입력 소재의 사건, 주제, 맥락을
바탕으로 판단하세요.
'일상', '직장' 등 넓은 범주가 같다는 사실만으로 소재 사이에 구체적인 연결 근거가 있다고 판단하지 마세요.
소재 간 연결 근거가 부족한 경우 제안 보류는 적절할 수 있습니다.
반대로 연결 근거가 충분한데 제안을 보류했다면 해당 평가 기준에 따라 실패 여부를 판단하세요.
사례 ID나 기대 동작에만 의존하지 말고 입력 소재와 실제 AI 응답을 비교해 독립적으로 판정하세요.
다만 특정 키워드가 등장했다는 이유만으로 실패시키지 말고 실제 제안 내용과 문맥을 대조하세요.

글쓰기 제안 API는 can_suggest 필드를 반환합니다.
can_suggest가 false이면 제안을 보류한 것이며,
title, reason, direction이 null인 것은 정상적인 응답입니다.
S03과 S07처럼 소재 간 연결 근거가 부족한 경우,
제안을 보류했다는 이유만으로 실패 처리하지 마세요.
각 평가 기준에 따라 보류 판단이 타당한지 평가하세요.
반대로 소재 간 연결 근거가 충분한데 제안을 보류했다면,
필요한 제안을 제공하지 못한 문제를 해당 평가 기준에 따라 검토하세요.
can_suggest가 true이면 실제 생성된 title, reason, direction을 평가하세요.
두 평가 기준은 기존 정의대로 독립적으로 판정하세요.

원래 자료로 판단할 때 각 기준의 결과는 '통과' 또는 '실패'로 답하세요.
응답에서 확인되는 근거를 구체적으로 적고 개선 사항을 짧은 한국어로 작성하세요.
자동 판정은 사람이 최종 검토할 예비 판정입니다.
반드시 아래 형식의 JSON 객체 하나만 반환하세요.
{"results":[{"criterion":"기준명","decision":"통과","reason":"판단 근거","improvement":"개선할 사항 (없으면 빈 문자열)"}]}
results는 입력 기준의 이름과 개수가 정확히 같아야 합니다.'''

    response_judge = client.chat.completions.create(
        model=JUDGE_MODEL,
        temperature=0,
        response_format={'type': 'json_object'},
        messages=[
            {'role': 'system', 'content': instruction},
            {'role': 'user', 'content': json.dumps(payload, ensure_ascii=False)},
        ],
    )
    parsed = json.loads(response_judge.choices[0].message.content)
    outputs = {}
    for item in parsed.get('results', []):
        key = str(item.get('criterion', '')).strip()
        decision = str(item.get('decision', '')).strip()
        if key not in case['criteria'] or key in outputs or decision not in ('통과', '실패'):
            raise ValueError('예비 평가 기준/판정이 유효하지 않습니다: ' + str(item))
        outputs[key] = {
            'decision': decision,
            'reason': str(item.get('reason', '')).strip(),
            'improvement': str(item.get('improvement', '')).strip(),
        }
    if set(outputs) != set(case['criteria']):
        raise ValueError('예비 평가 기준 일부가 누락되었습니다')
    return outputs


def main():
    data = json.loads((HERE / 'proposal_cases.json').read_text(encoding='utf-8'))
    cases = data['cases']
    rubrics = data['rubrics']
    if not os.getenv('OPENAI_API_KEY'):
        sys.exit('OPENAI_API_KEY를 찾지 못했습니다. rowflow_ai_server/.env 파일을 확인하세요. 키는 공유하지 마세요.')

    client = OpenAI(api_key=os.environ['OPENAI_API_KEY'])
    dest = HERE / 'proposal_runner' / 'results' / dt.datetime.now().strftime('%Y%m%d_%H%M%S_%f')
    dest.mkdir(parents=True, exist_ok=False)

    details = []
    totals = []
    raw = []
    for case in cases:
        cid = case['id']
        body = {'materials': case['materials']}
        actual = {}
        judgments = {}
        error = ''
        api_error = ''
        print(f'{cid}: /api/proposal/recommend 호출...', flush=True)
        try:
            response = requests.post(
                BASE_URL + '/api/proposal/recommend', json=body, timeout=120
            )
            response.raise_for_status()
            actual = response.json()
            validate_proposal_response(actual)
        except Exception as exc:
            api_error = type(exc).__name__ + ': ' + str(exc)
            print('  API 오류:', api_error[:200], flush=True)

        if not api_error:
            try:
                judgments = prelim_judge(client, case, actual, rubrics)
            except Exception as exc:
                error = type(exc).__name__ + ': ' + str(exc)
                print('  자동 평가 오류:', error[:200], flush=True)

        statuses = []
        reasons = []
        improvements = []
        for criterion in case['criteria']:
            value = judgments.get(criterion, {})
            status = value.get('decision', '평가 보류')
            reason = value.get('reason', api_error or error or '예비 판정 결과 없음')
            improvement = value.get('improvement', '')
            statuses.append(status)
            reasons.append('[' + criterion + '] ' + reason)
            if improvement:
                improvements.append('[' + criterion + '] ' + improvement)

            details.append({
                '사례 ID': cid,
                '평가 대상': '글쓰기 제안',
                '평가 기준': criterion,
                '테스트 입력': case['input'],
                '기대 동작': case['expected'],
                '실제 AI 응답': json.dumps(actual, ensure_ascii=False),
                '평가 결과': status,
                '판단 근거': reason,
                '개선 필요 사항': improvement,
                'API 경로': '/api/proposal/recommend',
                '예비 평가 모델': JUDGE_MODEL,
            })

        overall = (
            '평가 보류' if '평가 보류' in statuses
            else '통과' if all(status == '통과' for status in statuses)
            else '실패'
        )
        totals.append({
            '사례 ID': cid,
            '평가 대상': '글쓰기 제안',
            '평가 기준': '·'.join(case['criteria']),
            '테스트 입력': case['input'],
            '기대 동작': case['expected'],
            '실제 AI 응답': json.dumps(actual, ensure_ascii=False),
            '평가 결과': overall,
            '판단 근거': '\n'.join(reasons),
            '개선 필요 사항': '\n'.join(improvements),
        })
        raw.append({
            'case_id': cid,
            'timestamp': dt.datetime.now().astimezone().isoformat(),
            'path': '/api/proposal/recommend',
            'request': body,
            'response': actual,
            'judge_model': JUDGE_MODEL,
            'assessments': judgments,
            'api_error': api_error,
            'judge_error': error,
        })
        save_csv(dest / 'S01_S08_기준별평가.csv', details, COLS + ['API 경로', '예비 평가 모델'])
        save_csv(dest / 'S01_S08_평가결과.csv', totals, COLS)
        with (dest / 'responses.jsonl').open('w', encoding='utf-8') as f:
            for item in raw:
                f.write(json.dumps(item, ensure_ascii=False) + '\n')
        print(
            '  예비 종합 판정:', overall, ' / ',
            ', '.join(name + ': ' + status for name, status in zip(case['criteria'], statuses)),
            flush=True,
        )

    print('\n완료. 결과 저장 경로:', dest, flush=True)
    print('주의: 자동 판정은 예비 평가입니다. 실제 모델과 프롬프트 버전은 서버 코드에서 별도 확인하세요.')


if __name__ == '__main__':
    main()
