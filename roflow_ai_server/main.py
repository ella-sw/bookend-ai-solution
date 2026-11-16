from fastapi import FastAPI
from pydantic import BaseModel
from openai import OpenAI
import os
import json
from dotenv import load_dotenv

# .env 파일에 적어둔 API 키를 불러옵니다.
load_dotenv()
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

app = FastAPI(title="Rowflow AI API Server", version="1.0")

@app.get("/")
def read_root():
    return {"message": "Rowflow AI 서버가 정상 작동 중입니다!"}

# ==========================================
# 1. 소재 추출 API (M120)
# ==========================================
class ExtractRequest(BaseModel):
    record_text: str  

@app.post("/api/material/extract")
def extract_material(req: ExtractRequest):
    system_prompt = """
    당신은 사용자의 일상 기록에서 글감을 추출하는 전문 AI 편집자입니다.
    반드시 아래 JSON 형식으로만 응답하세요. 다른 말은 덧붙이지 마세요.
    {
        "summary": "핵심 내용을 1문장으로 요약",
        "keywords": ["핵심단어1", "핵심단어2", "핵심단어3"],
        "topic": "가족" 
    }
    - 주의: topic은 반드시 '가족', '일상', '일' 중 가장 알맞은 1개만 선택해야 합니다.
    """
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": req.record_text}
        ],
        response_format={"type": "json_object"}, 
        temperature=0.3 
    )
    return json.loads(response.choices[0].message.content)

# ==========================================
# 2. AI 다음 질문 생성 API (W210)
# ==========================================
class QnARequest(BaseModel):
    chat_history: list  

@app.post("/api/qna/next")
def get_next_question(req: QnARequest):
    system_prompt = """
    당신은 사용자의 일상과 감정을 깊이 있게 이끌어내는 전문 인터뷰어입니다.
    사용자의 이전 대화 기록을 분석하여, 글감을 더 풍성하게 만들 수 있는 '단 하나의 꼬리 질문'만 작성하세요.
    
    [절대 규칙]
    1. 반드시 아래 JSON 형식으로만 응답할 것.
    {
        "next_question": "생성된 질문 내용"
    }
    2. 너무 뻔하거나 딱딱한 질문은 피하고, 구체적인 상황을 짚어주는 다정한 말투를 사용할 것.
    """
    messages = [{"role": "system", "content": system_prompt}] + req.chat_history
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=messages,
        response_format={"type": "json_object"}, 
        temperature=0.7 
    )
    return json.loads(response.choices[0].message.content)

# ==========================================
# 3. AI 에세이 초안 생성 API (W330)
# ==========================================
class DraftRequest(BaseModel):
    materials: list
    direction: str
    tone: str
    length: str

@app.post("/api/essay/draft")
def generate_draft(req: DraftRequest):
    system_prompt = f"""
    당신은 사용자의 기록을 바탕으로 에세이를 작성하는 전문 작가입니다.
    
    [절대 규칙]
    1. 사용자가 제공한 '소재'와 '글의 방향'에 없는 새로운 사건이나 인물을 절대 지어내지 마세요.
    2. 사용자가 요청한 문체({req.tone})와 분량({req.length})을 반드시 지켜서 작성하세요.
    3. 반드시 아래 JSON 형식으로만 응답하세요.
    {{
        "draft_content": "작성된 에세이 초안 본문"
    }}
    """
    user_prompt = f"- 소재 목록: {req.materials}\n- 글의 방향: {req.direction}"
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        response_format={"type": "json_object"},
        temperature=0.7
    )
    return json.loads(response.choices[0].message.content)

# ==========================================
# 4. AI 글 다시 만들기 (재생성) API (W340)
# ==========================================
class RetouchRequest(BaseModel):
    original_draft: str  
    feedback: str        

@app.post("/api/essay/retouch")
def retouch_draft(req: RetouchRequest):
    system_prompt = """
    당신은 에세이 전문 교정 편집자입니다.
    사용자가 작성한 '기존 초안'과 '수정 요청 사항'을 바탕으로 글을 자연스럽게 다시 작성해 주세요.
    
    [절대 규칙]
    1. 반드시 아래 JSON 형식으로만 응답할 것.
    {
        "retouched_content": "수정된 에세이 본문"
    }
    2. 사용자의 수정 요청을 정확히 반영하되, 지어낸 사실을 추가하지 말고 전체적인 문맥이 어색해지지 않도록 다듬을 것.
    """
    user_prompt = f"- 기존 초안:\n{req.original_draft}\n- 수정 요청 사항:\n{req.feedback}"
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        response_format={"type": "json_object"},
        temperature=0.7 
    )
    return json.loads(response.choices[0].message.content)