from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI
import os
import json
from dotenv import load_dotenv

# .env 파일에 적어둔 API 키를 불러옵니다.
load_dotenv()
client = OpenAI(
    api_key=os.getenv("ELICE_API_KEY"),
    base_url=os.getenv("ELICE_BASE_URL")
)

app = FastAPI(title="Rowflow AI API Server", version="1.0")

# ==========================================
# [피드백 ④ 반영] CORS 설정 추가
# 프론트엔드(브라우저)에서 API를 직접 호출할 수 있도록 허용합니다.
# ==========================================
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 나중에 Vercel 도메인이 나오면 해당 도메인만 허용하도록 바꿀 수 있습니다.
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"message": "Rowflow AI 서버가 정상 작동 중입니다!"}

# ==========================================
# 1. 소재 추출 API (M120)
# [피드백 ① 반영] 주제 10개 중 1개 이상 다중 선택 (배열 형태)
# [피드백 ② 반영] 응답 항목에 title, evidence 추가
# ==========================================
class ExtractRequest(BaseModel):
    record_text: str  

@app.post("/api/material/extract")
def extract_material(req: ExtractRequest):
    system_prompt = """
    당신은 사용자의 일상 기록에서 글감을 추출하는 전문 AI 편집자입니다.

    [절대 규칙]
    1. 팩트 유지: 원문에 없는 감정(예: 자신감 등)을 지어내거나, 사건의 장소나 순서를 절대 바꾸지 마세요. 중심 소재가 아닌 단순 배경 요소(예: 마시던 커피 등)는 키워드에서 제외하세요.
    2. 근거 문장(evidence): 요약된 내용에 감정이 포함되어 있다면, 단편적인 행동만 발췌하지 말고 감정과 심리 상태가 드러난 원문 문장도 반드시 함께 발췌하세요.
    3. 주제(topic_ids) 엄격 분류:
       - '관계': 인물 간의 유대, 갈등, 관계의 변화가 중심일 때만 선택하세요. (단순한 일회성 친절이나 감사 표현만 있는 경우는 제외)
       - '취향·취미': 해당 활동이나 선호 자체가 글의 중심 소재일 때만 선택하세요. (단순히 좋아하는 활동이 배경으로 등장한 경우는 제외)
       - 반드시 다음 10개 중 1개 이상을 선택하세요: [가족, 관계, 나·성장, 일·직업, 일상, 여행·장소, 음식, 취향·취미, 몸·건강, 자연·계절]

    반드시 아래 JSON 형식으로만 응답하세요. 다른 말은 덧붙이지 마세요.
    {
        "title": "추출된 소재의 핵심을 담은 짧은 제목",
        "summary": "핵심 내용을 1문장으로 요약",
        "keywords": ["핵심단어1", "핵심단어2", "핵심단어3"],
        "topic_ids": ["선택된 주제1", "선택된 주제2"],
        "evidence": "소재 추출의 근거가 되는 원본 기록 내 문장 발췌"
    }
    """
    response = client.chat.completions.create(
        model="gpt-6-luna",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": req.record_text}
        ],
        response_format={"type": "json_object"}, 
        # temperature=0.3 
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
    사용자의 이전 대화 기록을 분석하여, 글감을 더 풍성하게 만들 수 있는 꼬리 질문을 작성하세요.
    
    [절대 규칙]
    1. 반드시 아래 JSON 형식으로만 응답할 것.
    {
        "next_question": "생성된 질문 내용"
    }
    2. 복합 질문 절대 금지: 한 번의 응답에는 오직 1개의 물음표(?)만 사용하세요. (예: "A는 무엇이고, B는 어땠나요?"처럼 두 가지를 동시에 묻지 말고 가장 중요한 한 가지만 질문하세요.)
    3. 너무 뻔하거나 딱딱한 질문은 피하고, 구체적인 상황을 짚어주는 다정한 말투를 사용할 것.
    """
    messages = [{"role": "system", "content": system_prompt}] + req.chat_history
    response = client.chat.completions.create(
        model="gpt-6-luna",
        messages=messages,
        response_format={"type": "json_object"}, 
        # temperature=0.7 
    )
    return json.loads(response.choices[0].message.content)

{
  "chat_history": [
    {
      "role": "assistant",
      "content": "퇴사하게 된 이유는 무엇인가요?"
    },
    {
      "role": "user",
      "content": "퇴사 이유는 자세히 쓰고 싶지 않아요. 마지막 날 제 책상 서랍을 비우던 장면만 남기고 싶어요."
    }
  ]
}
# ==========================================
# 2-2. AI 다른 질문 보기 (재생성) API (W220)
# [추가] 분석가 피드백 Q08 반영: 기존 질문과 겹치지 않는 새로운 질문 생성
# ==========================================
class QnAAltRequest(BaseModel):
    chat_history: list
    rejected_questions: list  # 사용자가 이미 본(스킵한) 질문들의 목록

@app.post("/api/qna/alternative")
def get_alternative_question(req: QnAAltRequest):
    system_prompt = f"""
    당신은 사용자의 일상과 감정을 깊이 있게 이끌어내는 전문 인터뷰어입니다.
    사용자의 이전 대화 기록을 분석하여, 글감을 더 풍성하게 만들 수 있는 '새로운' 꼬리 질문을 작성하세요.
    
    [절대 규칙]
    1. 반드시 아래 JSON 형식으로만 응답할 것.
    {{
        "next_question": "생성된 질문 내용"
    }}
    2. 복합 질문 절대 금지: 한 번의 응답에는 오직 1개의 물음표(?)만 사용하세요.
    3. 너무 뻔하거나 딱딱한 질문은 피하고, 구체적인 상황을 짚어주는 다정한 말투를 사용할 것.
    4. [중요] 아래에 나열된 기존 질문들과 의미나 형태가 겹치지 않는 완전히 새로운 방향의 질문을 생성하세요.
       - 제외할 기존 질문 목록: {req.rejected_questions}
    """
    messages = [{"role": "system", "content": system_prompt}] + req.chat_history
    
    response = client.chat.completions.create(
        model="gpt-6-luna",
        messages=messages,
        response_format={"type": "json_object"}, 
        # temperature=0.8  # 다양한 질문이 나오도록 창의성(온도)을 살짝 높이는 것을 권장합니다.
    )
    return json.loads(response.choices[0].message.content)

# ==========================================
# 3. AI 에세이 초안 생성 API (W330)
# [수정] 프론트엔드 N120 화면과 맞추기 위해 'direction(글의 방향)' 추가
# ==========================================
class DraftRequest(BaseModel):
    materials: list
    tone: str
    length: str
    direction: str  # 추가된 파라미터 (글의 방향)

@app.post("/api/essay/draft")
def generate_draft(req: DraftRequest):
    # 단문, 장문 구체적 글자 수 매핑 (요구사항 정의서 W320 기준)
    length_guide = "300자에서 500자 사이" if req.length == "단문" else "1000자에서 1500자 사이"
    
    system_prompt = f"""
    당신은 사용자의 기록을 바탕으로 에세이를 작성하는 전문 작가입니다.
    
    [절대 규칙]
    1. 사용자가 제공한 '소재'에 없는 새로운 사건이나 인물을 절대 지어내지 마세요.
    2. 사용자가 제시한 '글의 방향'을 글의 핵심 주제와 흐름으로 삼아 자연스럽게 전개하세요. (만약 빈칸이라면 소재들만 자연스럽게 엮어주세요)
    3. 사용자가 요청한 문체({req.tone})로 작성하고, 분량은 반드시 **{length_guide}**로 작성하세요. 공백을 포함한 분량입니다.
    4. 반드시 아래 JSON 형식으로만 응답하세요.
    {{
        "essay_content": "작성된 에세이 초안 본문"
    }}
    """
    # AI가 참고할 수 있도록 글의 방향을 추가해서 전달합니다.
    user_prompt = f"- 글의 방향: {req.direction}\n- 소재 목록: {req.materials}"
    
    response = client.chat.completions.create(
        model="gpt-6-luna",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        response_format={"type": "json_object"},
        # temperature=0.7
    )
    
    return json.loads(response.choices[0].message.content)

# ==========================================
# 4. AI 글 다시 만들기 (재생성) API (W340)
# [피드백 ③ 반영] feedback 입력칸 제거, '처음 고른 소재'를 파라미터로 받음
# ==========================================
class RetouchRequest(BaseModel):
    original_draft: str        # 기존에 생성되었던 초안 내용
    selected_materials: list   # 피드백 대신, 처음 고른 소재 리스트를 받음

@app.post("/api/essay/retouch")
def retouch_draft(req: RetouchRequest):
    system_prompt = """
    당신은 에세이 전문 교정 편집자입니다.
    사용자가 작성한 '기존 초안'과 글의 뼈대가 되는 '처음 고른 소재'를 바탕으로 글을 자연스럽게 다듬고 다시 작성해 주세요.
    
    [절대 규칙]
    1. 반드시 아래 JSON 형식으로만 응답할 것.
    {
        "retouched_content": "수정된 에세이 본문"
    }
    2. 처음 고른 소재에 없는 지어낸 사실을 추가하지 말고, 전체적인 문맥이 어색해지지 않게 다듬을 것.
    """
    user_prompt = f"- 기존 초안:\n{req.original_draft}\n- 처음 고른 소재:\n{req.selected_materials}"
    response = client.chat.completions.create(
        model="gpt-6-luna",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        response_format={"type": "json_object"},
        # temperature=0.7 
    )
    return json.loads(response.choices[0].message.content)

# ==========================================
# 5. 글쓰기 제안 API (N130)
# [추가] 제목, 추천 이유, 글의 방향을 한 번에 생성하여 제안하는 기능
# ==========================================
class ProposalRequest(BaseModel):
    materials: list  # 사용자가 선택했거나 AI가 묶어준 소재 리스트

@app.post("/api/proposal/recommend")
def recommend_proposal(req: ProposalRequest):
    system_prompt = """
    당신은 사용자의 일상 기록(소재)들을 엮어서 한 편의 완성된 글을 쓸 수 있도록 기획안을 제안하는 전문 에디터입니다.
    사용자가 제시한 소재들을 바탕으로 다음 3가지 항목을 작성해 주세요.
    
    [절대 규칙]
    1. 반드시 아래 JSON 형식으로만 응답할 것.
    {
        "title": "글의 핵심 주제를 담은 짧은 제목",
        "reason": "왜 이 소재들을 묶어서 글을 쓰면 좋은지 사용자에게 설명하는 다정한 추천 이유",
        "direction": "글을 어떻게 엮을지 구조를 지시하는 명확한 한 문장"
    }
    2. 'direction(글의 방향)'은 'title(제목)'을 다른 말로 단순 반복해서는 안 됩니다. AI가 실제로 초안을 작성할 때 뼈대가 될 수 있도록, 구체적인 전개 방식(예: 시간 순서, 두 사건의 대비, 특정 장면에서 시작 등)을 지시하세요.
    """
    user_prompt = f"- 선택된 소재 목록:\n{req.materials}"
    
    response = client.chat.completions.create(
        model="gpt-6-luna",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        response_format={"type": "json_object"},
        # temperature=0.7
    )
    return json.loads(response.choices[0].message.content)
