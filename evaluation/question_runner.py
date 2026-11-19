# -*- coding: utf-8 -*-
"""Rowflow 후속 질문 Q01~Q08: API 응답 수집 및 기준별 LLM 예비 판정.

실행: python question_runner.py
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


def csv_save(path, rows, columns):
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction='ignore')
        writer.writeheader()
        writer.writerows(rows)


def judge(client, case, response, rubrics):
    """실제 입력·응답과 루브릭만으로 예비 판정; 기대 동작은 전달하지 않음."""
    criteria = [{'criterion': name, **rubrics[name]} for name in case['criteria']]
    payload = {
        'chat_history': case['chat_history'],
        'rejected_questions': case.get('rejected_questions', []),
        'actual_response': response,
        'criteria': criteria,
    }
    prompt = '''당신은 Rowflow 한국어 후속 질문 생성의 품질 평가 보조자입니다.
주어진 대화 이력, 제외된 질문, 실제 생성 질문을 근거로 품질을 평가하세요.
한 사례에 지정된 평가 기준만 각각 독립적으로 판정하세요. 다른 기준으로 대체하거나 추가하지 마세요.
질문의 표현 자체가 명확하고 간결한지와 기존 문답 또는 거절된 질문과 의미상 중복되는지는 별개로 판단하세요.
질문이 여러 내용을 동시에 요구하는지 확인하고, 물음표 개수만으로 판정하지 마세요.
이미 답한 사실을 다른 말로 다시 묻는 경우와 기존 답을 더 구체화하는 새로운 질문을 구별하세요.
제외된 질문의 단어만 바꾸어 사실상 같은 내용을 다시 묻는지도 확인하세요.
대화에서 확인할 수 없는 사정이나 감정을 임의로 가정하지 마세요.
각 기준은 반드시 '통과' 또는 '실패'로 판정하세요.
문제되는 표현을 구체적으로 짚어 간결한 한국어 근거 및 개선 사항을 작성하세요.
이것은 사람이 최종 검토할 자동 예비 판정입니다.
반드시 다음 형식의 JSON 객체 하나만 반환하세요.
{"results":[{"criterion":"기준명","decision":"통과","reason":"판단 근거","improvement":"개선점 또는 빈 문자열"}]}
results는 제공된 평가 기준의 이름과 개수가 정확히 일치해야 합니다.'''
    result = client.chat.completions.create(
        model=JUDGE_MODEL,
        temperature=0,
        response_format={'type': 'json_object'},
        messages=[
            {'role': 'system', 'content': prompt},
            {'role': 'user', 'content': json.dumps(payload, ensure_ascii=False)},
        ],
    )
    parsed = json.loads(result.choices[0].message.content)
    items = parsed.get('results', [])
    if not isinstance(items, list):
        raise ValueError('자동 평가 결과 형식이 잘못됨: results')
    output = {}
    for item in items:
        if not isinstance(item, dict):
            raise ValueError('자동 평가 결과 항목이 객체가 아닙니다')
        name = str(item.get('criterion', '')).strip()
        decision = str(item.get('decision', '')).strip()
        if name not in case['criteria'] or name in output or decision not in ('통과', '실패'):
            raise ValueError('자동 평가 기준명 또는 판정이 유효하지 않음: ' + str(item))
        output[name] = {
            'decision': decision,
            'reason': str(item.get('reason', '')).strip(),
            'improvement': str(item.get('improvement', '')).strip(),
        }
    if set(output) != set(case['criteria']):
        raise ValueError('자동 평가 일부 기준 누락')
    return output


def main():
    dataset = json.loads((HERE / 'question_cases.json').read_text(encoding='utf-8'))
    cases = dataset['cases']
    rubrics = dataset['rubrics']
    key = os.getenv('OPENAI_API_KEY')
    if not key:
        sys.exit('OPENAI_API_KEY가 없습니다. rowflow_ai_server/.env 파일을 확인하세요. 키 내용은 공유하지 마세요.')

    client = OpenAI(api_key=key)
    dest = HERE / 'question_runner' / 'results' / dt.datetime.now().strftime('%Y%m%d_%H%M%S_%f')
    dest.mkdir(parents=True, exist_ok=False)
    detail = []
    totals = []
    raws = []

    for case in cases:
        cid = case['id']
        path = '/api/qna/alternative' if cid == 'Q08' else '/api/qna/next'
        body = {'chat_history': case['chat_history']}
        if cid == 'Q08':
            body['rejected_questions'] = case['rejected_questions']

        response_body = {}
        assessments = {}
        api_error = ''
        judge_error = ''
        print(f'{cid}: {path} 호출...', flush=True)

        try:
            response = requests.post(BASE_URL + path, json=body, timeout=120)
            response.raise_for_status()
            response_body = response.json()
            if (
                not isinstance(response_body, dict)
                or not isinstance(response_body.get('next_question'), str)
                or not response_body['next_question'].strip()
            ):
                raise ValueError('API 응답에 next_question 문자열이 없음')
        except Exception as exc:
            api_error = f'{type(exc).__name__}: {exc}'
            print('  API 오류:', api_error[:180], flush=True)

        if not api_error:
            try:
                assessments = judge(client, case, response_body, rubrics)
            except Exception as exc:
                judge_error = f'{type(exc).__name__}: {exc}'
                print('  자동 평가 오류:', judge_error[:180], flush=True)

        statuses = []
        reasons = []
        suggestions = []
        for criterion in case['criteria']:
            value = assessments.get(criterion, {})
            status = value.get('decision', '평가 보류')
            reason = value.get('reason', api_error or judge_error or '자동 판정을 확보하지 못함')
            suggestion = value.get('improvement', '')
            statuses.append(status)
            reasons.append(f'[{criterion}] {reason}')
            if suggestion:
                suggestions.append(f'[{criterion}] {suggestion}')

            detail.append({
                '사례 ID': cid,
                '평가 대상': '다른 질문 보기' if cid == 'Q08' else 'AI 후속 질문',
                '평가 기준': criterion,
                '테스트 입력': case['input'],
                '기대 동작': case['expected'],
                '실제 AI 응답': json.dumps(response_body, ensure_ascii=False),
                '평가 결과': status,
                '판단 근거': reason,
                '개선 필요 사항': suggestion,
                'API 경로': path,
                '예비 평가 모델': JUDGE_MODEL,
            })

        overall = (
            '평가 보류' if '평가 보류' in statuses
            else '통과' if all(value == '통과' for value in statuses)
            else '실패'
        )
        totals.append({
            '사례 ID': cid,
            '평가 대상': '다른 질문 보기' if cid == 'Q08' else 'AI 후속 질문',
            '평가 기준': '·'.join(case['criteria']),
            '테스트 입력': case['input'],
            '기대 동작': case['expected'],
            '실제 AI 응답': json.dumps(response_body, ensure_ascii=False),
            '평가 결과': overall,
            '판단 근거': '\n'.join(reasons),
            '개선 필요 사항': '\n'.join(suggestions),
        })
        raws.append({
            'case_id': cid,
            'timestamp': dt.datetime.now().astimezone().isoformat(),
            'path': path,
            'request': body,
            'response': response_body,
            'judge_model': JUDGE_MODEL,
            'assessments': assessments,
            'api_error': api_error,
            'judge_error': judge_error,
        })

        csv_save(dest / 'Q01_Q08_기준별평가.csv', detail, COLS + ['API 경로', '예비 평가 모델'])
        csv_save(dest / 'Q01_Q08_평가결과.csv', totals, COLS)
        with (dest / 'responses.jsonl').open('w', encoding='utf-8') as f:
            for row in raws:
                f.write(json.dumps(row, ensure_ascii=False) + '\n')
        print(
            '  예비 종합 판정:', overall, ' / ',
            ', '.join(f'{name}: {status}' for name, status in zip(case['criteria'], statuses)),
            flush=True,
        )

    print('\n완료. 저장 위치:', dest, flush=True)
    print('자동 판정은 예비 판정입니다. 사람이 응답과 근거를 검토한 후 확정하세요.')
    print('서비스 생성 모델 및 프롬프트 버전은 서버 코드에서 별도로 확인하세요.')


if __name__ == '__main__':
    main()
