# -*- coding: utf-8 -*-
"""Rowflow 에세이 생성 E01~E08: API 응답 수집 + LLM 기준별 예비판정 + 실제 글자 수 검증."""
import csv
import datetime as dt
import json
import os
from pathlib import Path
import sys
import requests
from dotenv import load_dotenv
from openai import OpenAI

HERE=Path(__file__).resolve().parent
load_dotenv(HERE/'.env');load_dotenv(HERE.parent/'.env')
BASE_URL=os.getenv('ROWFLOW_API_BASE_URL','http://127.0.0.1:8000').rstrip('/')
JUDGE_MODEL=os.getenv('ROWFLOW_JUDGE_MODEL','gpt-4o-mini')
COLS=['사례 ID','평가 대상','평가 기준','테스트 입력','기대 동작','실제 AI 응답','평가 결과','판단 근거','개선 필요 사항']


def save_csv(path, rows, columns):
    with path.open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=columns,extrasaction='ignore')
        writer.writeheader();writer.writerows(rows)


def judge(client,case,actual,rubrics,char_count):
    criteria=[{'criterion':x,'rule':rubrics[x]} for x in case['criteria'] if x!='분량 조건 준수']
    if not criteria:return {}
    payload={'case_id':case['id'],'source_materials':case['materials'],
             'full_test_input':case['input'],'expected_behavior':case['expected'],
             'requested_tone':case['tone'],'direction':case['direction'],
             'requested_length':case['length'],'actual_character_count':char_count,
             'actual_essay':actual['essay_content'],'criteria':criteria}
    instruction='''당신은 한국어 에세이 품질 평가 보조자입니다. 반드시 JSON 객체 하나로 응답하세요.
주어진 criterion 각각만 평가하고, 평가 기준에 없는 항목으로 판정을 대체하지 마세요.
원문과 대조하여 창작된 사건, 인물, 확정적 감정, 시간/인과관계 왜곡 여부를 판단하세요.
글의 방향이나 문체가 감성적이더라도 사실 없는 구체적 사건은 허용하지 마세요.
한편 단순 문학적 비유를 무조건 사실 추가로 판단하지는 마세요.
평가 기준별로 통과/실패 중 하나로 예비 판정하세요. 불확실한 표현은 판단 근거에 명시하세요.
문체는 요청한 톤과 글 전체의 일관성을 확인하세요. 초안 내용을 꼼꼼히 읽고 판단하세요.
분량 조건은 별도 프로그램이 정확히 측정하므로 당신은 판정하지 않습니다.
형식: {"results":[{"criterion":"기준명","decision":"통과","reason":"짧고 구체적인 한국어 근거","improvement":"개선 필요시 한국어 설명, 없으면 빈 문자열"}]}
results에 제공된 모든 기준을 정확히 한 번씩 담으세요.'''
    result=client.chat.completions.create(model=JUDGE_MODEL,temperature=0,
        response_format={'type':'json_object'},messages=[
           {'role':'system','content':instruction},
           {'role':'user','content':json.dumps(payload,ensure_ascii=False)}])
    parsed=json.loads(result.choices[0].message.content)
    found={}
    for x in parsed.get('results',[]):
        k=x.get('criterion');v=x.get('decision')
        if k not in [y['criterion'] for y in criteria] or k in found or v not in ('통과','실패'):
            raise ValueError('예비 판정 기준/결과 불일치: '+repr(x))
        found[k]={'decision':v,'reason':str(x.get('reason','')),'improvement':str(x.get('improvement',''))}
    if set(found)!={x['criterion'] for x in criteria}:raise ValueError('일부 평가 기준 누락')
    return found


def main():
    data=json.loads((HERE/'essay_cases.json').read_text(encoding='utf-8'))
    if not os.getenv('OPENAI_API_KEY'):
        sys.exit('OPENAI_API_KEY 환경변수가 없습니다. roflow_ai_server/.env를 확인하세요 (키는 공유하지 마세요).')
    client=OpenAI(api_key=os.environ['OPENAI_API_KEY'])
    dest=HERE/'essay_runner'/'results'/dt.datetime.now().strftime('%Y%m%d_%H%M%S')
    dest.mkdir(parents=True,exist_ok=True)
    details=[];totals=[];raw=[]
    for case in data['cases']:
        cid=case['id'];body={k:case[k] for k in ('materials','tone','length','direction')}
        actual={};api_error='';judge_error='';assessments={};count=None
        print(f'{cid}: POST /api/essay/draft...',flush=True)
        try:
            resp=requests.post(BASE_URL+'/api/essay/draft',json=body,timeout=180)
            resp.raise_for_status();actual=resp.json()
            if not isinstance(actual,dict) or not isinstance(actual.get('essay_content'),str):
                raise ValueError('essay_content 문자열이 반환되지 않았습니다')
            # Python len(str): 공백/개행 포함, Unicode 코드포인트 기준; 분량 경계 300~500, 1000~1500
            count=len(actual['essay_content'])
            lo,hi=(1000,1500) if case['length']=='장문' else (300,500)
            assessments['분량 조건 준수']={
                'decision':'통과' if lo<=count<=hi else '실패',
                'reason':f'공백 및 줄바꿈 포함 {count}자; 요구 범위 {lo}~{hi}자',
                'improvement':'' if lo<=count<=hi else f'공백 포함 글자 수를 {lo}~{hi}자 범위로 조정'}
        except Exception as e:
            api_error=f'{type(e).__name__}: {e}'
            print('  API 오류:',api_error[:250],flush=True)
        if not api_error:
            try:assessments.update(judge(client,case,actual,data['rubrics'],count))
            except Exception as e:
                judge_error=f'{type(e).__name__}: {e}'
                print('  자동 판정 오류:',judge_error[:250],flush=True)
        statuses=[];reasons=[];improvements=[]
        for criterion in case['criteria']:
            item=assessments.get(criterion,{})
            status=item.get('decision','평가 보류')
            reason=item.get('reason',api_error or judge_error or '예비 판정 결과 없음')
            improvement=item.get('improvement','')
            statuses.append(status);reasons.append(f'[{criterion}] {reason}')
            if improvement:improvements.append(f'[{criterion}] {improvement}')
            details.append({'사례 ID':cid,'평가 대상':'에세이 생성','평가 기준':criterion,
                '테스트 입력':case['input'],'기대 동작':case['expected'],
                '실제 AI 응답':json.dumps(actual,ensure_ascii=False),
                '평가 결과':status,'판단 근거':reason,'개선 필요 사항':improvement,
                '실제 글자 수(공백 포함)':count,'API 경로':'/api/essay/draft','예비 평가 모델':JUDGE_MODEL})
        overall='평가 보류' if '평가 보류' in statuses else '통과' if all(x=='통과' for x in statuses) else '실패'
        totals.append({'사례 ID':cid,'평가 대상':'에세이 생성','평가 기준':'·'.join(case['criteria']),
            '테스트 입력':case['input'],'기대 동작':case['expected'],
            '실제 AI 응답':json.dumps(actual,ensure_ascii=False),
            '평가 결과':overall,'판단 근거':'\n'.join(reasons),
            '개선 필요 사항':'\n'.join(improvements),'실제 글자 수(공백 포함)':count})
        raw.append({'case_id':cid,'timestamp':dt.datetime.now().astimezone().isoformat(),
            'path':'/api/essay/draft','request':body,'response':actual,'character_count':count,
            'judge_model':JUDGE_MODEL,'assessments':assessments,
            'api_error':api_error,'judge_error':judge_error})
        save_csv(dest/'E01_E08_기준별평가.csv',details,COLS+['실제 글자 수(공백 포함)','API 경로','예비 평가 모델'])
        save_csv(dest/'E01_E08_평가결과.csv',totals,COLS+['실제 글자 수(공백 포함)'])
        with (dest/'responses.jsonl').open('w',encoding='utf-8') as f:
            for x in raw:f.write(json.dumps(x,ensure_ascii=False)+'\n')
        print(f'  {count if count is not None else "측정 불가"}자 / 종합: {overall} / '+', '.join(f'{c}: {s}' for c,s in zip(case['criteria'],statuses)),flush=True)
    print('\n완료:',dest,flush=True)
    print('이 판정은 예비 판정이며, 모델·프롬프트 버전은 서버 코드에서 따로 기록하세요.')

if __name__=='__main__':main()
