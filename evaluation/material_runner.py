# -*- coding: utf-8 -*-
"""Rowflow 소재 추출 M01~M08: API 자동 수집 + LLM 예비 평가.

필요: pip install requests openai python-dotenv
실행: python material_runner.py
전제: FastAPI 서버가 http://127.0.0.1:8000 에 실행 중
판정: 통과 / 실패. API 오류 또는 판정 불능은 평가 보류로 구분.
"""
import csv
import datetime
import json
import os
from pathlib import Path
import sys
import time

import requests
from dotenv import load_dotenv
from openai import OpenAI

HERE = Path(__file__).resolve().parent
load_dotenv(HERE / '.env')
load_dotenv(HERE.parent / '.env')
API_URL = os.getenv('ROWFLOW_MATERIAL_URL', 'http://127.0.0.1:8000/api/material/extract')
JUDGE_MODEL = os.getenv('ROWFLOW_JUDGE_MODEL', 'gpt-4o-mini')
SOURCE_MODEL = 'gpt-4o-mini'  # 제공된 main.py 기준; 서버 실행 코드가 실제 같은지 별도 확인 필요


def write_csv(path, rows, cols):
    with path.open('w', encoding='utf-8-sig', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction='ignore')
        w.writeheader()
        w.writerows(rows)


def judge(client, case, response, rubrics):
    assessments = [
        {'name': name, 'description': rubrics[name]['description'],
         'pass_example': rubrics[name]['pass_example'],
         'fail_example': rubrics[name]['fail_example']}
        for name in case['criteria']
    ]
    payload={'input':case['input'],'expected_behavior':case['expected'],
             'actual_response':response,'assessments':assessments}
    instructions = """너는 Rowflow 서비스의 AI 품질 평가자다.
원문, 사례별 기대 동작, 실제 응답, 각 평가 기준의 정의를 함께 보고 기준마다 독립적으로 평가한다.
입력이 부족하다는 이유만으로 원문에 없는 내용을 지어낸 것을 허용하지 않는다.
평가 기준 2개를 각각 '통과' 또는 '실패'로 판단한다. 다른 기준을 멋대로 추가하지 않는다.
주제 분류는 허용된 10개 중 내용과 관련된 주제인지 살펴본다.
근거 문장 적절성은 실제 원문에 있는 문장인지와 소재를 뒷받침하는지를 확인한다.
각 기준에 대한 이유는 실제 응답에서 확인한 구체적 표현을 근거로 간결하게 한국어로 작성한다.
JSON 객체 하나만 반환한다. 반드시 다음 구조를 지킨다:
{"results":[{"criterion":"원문 충실성", "decision":"통과", "reason":"판단 근거", "improvement":"개선 필요 시 제안, 없으면 빈 문자열"}, ...]}
results 항목은 입력으로 받은 assessments의 기준명 및 개수와 정확히 일치해야 한다."""
    result = client.chat.completions.create(
       model=JUDGE_MODEL,
       messages=[{'role':'system','content':instructions},
                 {'role':'user','content':json.dumps(payload,ensure_ascii=False)}],
       response_format={'type':'json_object'}, temperature=0)
    data=json.loads(result.choices[0].message.content)
    got=data.get('results',[])
    if not isinstance(got,list):raise ValueError('판정 결과 results가 배열이 아닙니다')
    out={}
    for item in got:
        key=str(item.get('criterion','')).strip()
        decision=str(item.get('decision','')).strip()
        if key not in case['criteria'] or key in out or decision not in ('통과','실패'):
            raise ValueError('판정 기준 또는 결과 값이 잘못됐습니다: '+str(item))
        out[key]={'decision':decision,'reason':str(item.get('reason','')).strip(),
                  'improvement':str(item.get('improvement','')).strip()}
    if set(out)!=set(case['criteria']):raise ValueError('필요 평가 기준이 누락됐습니다')
    return out


def main():
    data=json.loads((HERE/'material_cases.json').read_text(encoding='utf-8'))
    cases=data['cases']; rubrics=data['rubrics']
    if not os.getenv('OPENAI_API_KEY'):
        sys.exit('OPENAI_API_KEY를 찾지 못했습니다. roflow_ai_server/.env를 확인하세요 (키를 공유하지 마세요).')
    client=OpenAI(api_key=os.getenv('OPENAI_API_KEY'))
    out_dir=HERE/'material_runner'/'results'/datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    out_dir.mkdir(parents=True,exist_ok=True)
    main_rows=[]; detail_rows=[]; raw_rows=[]
    for case in cases:
        cid=case['id']; response={}; judged={}; error=''
        print(f'{cid}: 소재 추출 API 호출 중...',flush=True)
        try:
            api_resp=requests.post(API_URL,json={'record_text':case['input']},timeout=120)
            api_resp.raise_for_status()
            response=api_resp.json()
            if not isinstance(response,dict): raise ValueError('API 응답이 JSON 객체가 아닙니다')
            missing={'title','summary','keywords','topic_ids','evidence'}-set(response)
            if missing:raise ValueError('API 응답 필드 누락: '+', '.join(sorted(missing)))
            judged=judge(client,case,response,rubrics)
        except Exception as exc:
            error=type(exc).__name__+': '+str(exc)
            print('  검토 필요:',error[:180])
        criterion_results=[]; reasons=[]; suggestions=[]
        for criterion in case['criteria']:
            j=judged.get(criterion,{})
            status=j.get('decision','평가 보류')
            reason=j.get('reason',error or '평가 결과를 확보하지 못함')
            improvement=j.get('improvement','')
            criterion_results.append(status)
            reasons.append(f'[{criterion}] {reason}')
            if improvement:suggestions.append(f'[{criterion}] {improvement}')
            detail_rows.append({'사례 ID':cid,'평가 대상':case['feature'],'평가 기준':criterion,
                                '테스트 입력':case['input'],'기대 동작':case['expected'],
                                '실제 AI 응답':json.dumps(response,ensure_ascii=False),
                                '평가 결과':status,'판단 근거':reason,'개선 필요 사항':improvement,
                                '생성 모델(코드 기준)':SOURCE_MODEL,'평가 모델':JUDGE_MODEL})
        overall=('평가 보류' if '평가 보류' in criterion_results else
                 '통과' if all(x=='통과' for x in criterion_results) else '실패')
        main_rows.append({'사례 ID':cid,'평가 대상':case['feature'],
             '평가 기준':'·'.join(case['criteria']),'테스트 입력':case['input'],
             '기대 동작':case['expected'],'실제 AI 응답':json.dumps(response,ensure_ascii=False),
             '평가 결과':overall,'판단 근거':'\n'.join(reasons),
             '개선 필요 사항':'\n'.join(suggestions)})
        raw_rows.append({'case_id':cid,'record_text':case['input'],'response':response,
                         'criterion_judgements':judged,'error':error,'evaluated_at':datetime.datetime.now().isoformat()})
        print(f'  결과: {overall} / '+', '.join(f'{x}: {y}' for x,y in zip(case['criteria'],criterion_results)),flush=True)
        # 오류 시에도 매 사례 뒤에 저장해 중간 결과를 보존합니다.
        cols=['사례 ID','평가 대상','평가 기준','테스트 입력','기대 동작',
              '실제 AI 응답','평가 결과','판단 근거','개선 필요 사항']
        write_csv(out_dir/'M01_M08_평가결과.csv',main_rows,cols)
        write_csv(out_dir/'M01_M08_기준별평가.csv',detail_rows,cols+['생성 모델(코드 기준)','평가 모델'])
        with (out_dir/'responses.jsonl').open('w',encoding='utf-8') as f:
            for item in raw_rows:f.write(json.dumps(item,ensure_ascii=False)+'\n')
    print('\n완료. 결과 폴더:',out_dir)
    print('주의: 자동 판정은 예비 평가입니다. 실제 응답과 판단 근거를 검토한 후 최종 확정하세요.')
    print('생성 모델명은 첨부된 main.py에서 읽은 설정값이며 서버별 실제 호출 메타데이터는 아닙니다.')

if __name__ == '__main__':main()
