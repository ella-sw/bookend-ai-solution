# -*- coding: utf-8 -*-
"""Rowflow R01~R08: collect API responses and preliminary rubric judgments. Human review is mandatory."""
import csv,datetime as dt,json,os,sys
from pathlib import Path
import requests
from dotenv import load_dotenv
from openai import OpenAI

HERE=Path(__file__).resolve().parent
load_dotenv(HERE/'.env');load_dotenv(HERE.parent/'.env')
BASE=os.getenv('ROWFLOW_API_BASE_URL','http://127.0.0.1:8000').rstrip('/')
JUDGE_MODEL=os.getenv('ROWFLOW_JUDGE_MODEL','gpt-4o-mini')
COLS=['사례 ID','평가 대상','평가 기준','테스트 입력','기대 동작','실제 AI 응답','평가 결과','판단 근거','개선 필요 사항']

def save_csv(path,rows,cols):
    with path.open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=cols,extrasaction='ignore');writer.writeheader();writer.writerows(rows)

def judge(client,c,essay,rubrics):
    criteria=[{'criterion':x,'rule':rubrics[x]} for x in c['criteria'] if x!='분량 조건 준수']
    if not criteria:return {}
    payload={'case_id':c['id'],'current_user_draft':c['current_draft'],
             'source_materials':c['selected_materials'],'test_input':c['input'],
             'expected_behavior':c['expected'],'user_edited':c['has_user_edit'],
             'requested_tone':c['tone'],'requested_length':c['length'],
             'retouched_essay':essay,'criteria':criteria}
    instruction='''당신은 에세이 재생성 품질의 예비 평가자입니다. 모든 답변은 JSON 객체 하나로만 작성하세요.
각 기준은 독립적으로 평가하고, 사용자가 제공한 평가 기준만 판정합니다.
특히 사용자 수정 반영은 '현재 사용자 수정본'에 새로 적은 생각이나 수정된 감정을 보존해야 함을 뜻합니다. 처음 선택 소재에 없더라도 사용자 직접 수정 내용을 삭제했다고 해서 원문 충실성 통과라고 판정하지 마세요.
원문 충실성은 현재 수정본과 선택 소재에 없는 새로운 사실·행동·확정적인 심리·인과관계가 생성됐는지 확인하세요. 단순 비유는 새 경험으로 단정하지 마세요.
핵심 내용 반영은 핵심 사건과 생각의 보존을, 문체 조건은 요청한 문체를 글 전체에서 지키는지를, 구성·연결성은 시간과 논리 전환의 자연스러움을, 문장 명확성·자연스러움은 문법 및 불필요한 반복을 독립적으로 평가하세요.
판정은 통과 또는 실패. 원문 근거를 특정해 짧고 구체적인 한국어 판단 근거를 작성하세요. LLM 판정은 임시이며 사람 검토가 필요합니다.
형식: {"results":[{"criterion":"정확한 기준명","decision":"통과","reason":"한국어 근거","improvement":"한국어 개선점 또는 빈 문자열"}]}
입력받은 모든 기준을 빠짐없이 정확히 한 번씩 평가하세요.'''
    answer=client.chat.completions.create(model=JUDGE_MODEL,temperature=0,response_format={'type':'json_object'},messages=[{'role':'system','content':instruction},{'role':'user','content':json.dumps(payload,ensure_ascii=False)}])
    parsed=json.loads(answer.choices[0].message.content)
    found={}
    for item in parsed.get('results',[]):
        key=item.get('criterion')
        if key not in [x['criterion'] for x in criteria] or key in found or item.get('decision') not in ('통과','실패'):
            raise ValueError('잘못된 예비 평가 결과: '+repr(item))
        found[key]={'decision':item['decision'],'reason':str(item.get('reason','')),'improvement':str(item.get('improvement',''))}
    if set(found)!={x['criterion'] for x in criteria}:raise ValueError('평가 항목 누락')
    return found

def main():
    payload=json.loads((HERE/'retouch_cases.json').read_text(encoding='utf-8'))
    if not os.getenv('OPENAI_API_KEY'):sys.exit('OPENAI_API_KEY가 없습니다. roflow_ai_server/.env를 확인하세요.')
    client=OpenAI(api_key=os.environ['OPENAI_API_KEY'])
    dst=HERE/'retouch_runner'/'results'/dt.datetime.now().strftime('%Y%m%d_%H%M%S')
    dst.mkdir(parents=True,exist_ok=True)
    all_details=[];all_totals=[];raw=[]
    for c in payload['cases']:
        print(c['id']+': POST /api/essay/retouch',flush=True)
        req={key:c[key] for key in ('current_draft','selected_materials','tone','length')}
        response={};api_error='';judge_error='';assess={}
        try:
            r=requests.post(BASE+'/api/essay/retouch',json=req,timeout=180)
            r.raise_for_status();response=r.json()
            if not isinstance(response,dict) or not isinstance(response.get('retouched_content'),str):
                raise ValueError('retouched_content 문자열이 반환되지 않았습니다.')
            essay=response['retouched_content'];n=len(essay)
            if '분량 조건 준수' in c['criteria']:
                lower,upper=(1000,1500) if c['length']=='장문' else (300,500)
                yes=lower<=n<=upper
                assess['분량 조건 준수']={'decision':'통과' if yes else '실패','reason':f'공백·줄바꿈 포함 {n}자 (기준 {lower}~{upper}자)','improvement':'' if yes else '범위를 벗어난 분량 조정; 내용 조작 없이 충실성 우선'}
            try:assess.update(judge(client,c,essay,payload['rubrics']))
            except Exception as e:judge_error=f'{type(e).__name__}: {e}';print('  예비 평가 오류:',judge_error[:200],flush=True)
        except Exception as e:
            api_error=f'{type(e).__name__}: {e}';print('  API 오류:',api_error[:200],flush=True)
        raw.append({'id':c['id'],'request':req,'response':response,'api_error':api_error,'judge_error':judge_error,'assessments':assess,'model_from_api':'서버 코드에서 확인 필요','judge_model':JUDGE_MODEL})
        for criterion in c['criteria']:
            a=assess.get(criterion,{'decision':'평가 보류','reason':api_error or judge_error or '평가 결과 없음','improvement':'재실행 후 확인'})
            all_details.append({'사례 ID':c['id'],'평가 대상':'에세이 재생성','평가 기준':criterion,'테스트 입력':c['input'],'기대 동작':c['expected'],'실제 AI 응답':json.dumps(response,ensure_ascii=False),'평가 결과':a['decision'],'판단 근거':a['reason'],'개선 필요 사항':a['improvement']})
        vals=[x['평가 결과'] for x in all_details if x['사례 ID']==c['id']]
        total='평가 보류' if '평가 보류' in vals else ('실패' if '실패' in vals else '통과')
        all_totals.append({'사례 ID':c['id'],'평가 대상':'에세이 재생성','평가 기준':' · '.join(c['criteria']),'테스트 입력':c['input'],'기대 동작':c['expected'],'실제 AI 응답':json.dumps(response,ensure_ascii=False),'평가 결과':total,'판단 근거':' / '.join(f"{x['평가 기준']}: {x['평가 결과']}" for x in all_details if x['사례 ID']==c['id']),'개선 필요 사항':''})
        save_csv(dst/'R01_R08_기준별평가.csv',all_details,COLS)
        save_csv(dst/'R01_R08_평가결과.csv',all_totals,COLS)
        with (dst/'responses.jsonl').open('w',encoding='utf-8') as f:
            for x in raw:f.write(json.dumps(x,ensure_ascii=False)+'\n')
    print('\n완료: '+str(dst),flush=True)
    print('반드시 예비 평가를 사람이 검토하고, 기존 결과를 덮어쓰지 마세요.',flush=True)
if __name__=='__main__':main()
