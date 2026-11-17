/**
 * 목업 응답 이름표. API 함수 하나 = 키 하나.
 * /dev/mock 화면에서 키마다 상황(정상·실패·시간 초과·소재 없음·느림·AI 실패)을 고를 수 있다.
 * 소재로 저장(records.free.save, qna.save)의 '분석 시작 실패'는 analysis.start 키의 상황(실패·연결 끊김·시간 초과)으로 고른다.
 */
export const MOCK_KEYS = {
  "user.start": "첫 실행 동의 (O110)",
  "home.get": "홈 데이터 (H110)",
  "topics.list": "주제 목록",
  "records.free.draft.get": "자유 기록 임시 저장 불러오기 (H121)",
  "records.free.draft.save": "자유 기록 임시 저장 (W111)",
  "records.free.save": "자유 기록 → 소재로 저장 (W110)",
  "records.keep": "원본만 보관 (M120)",
  "records.delete": "기록 삭제 (M132)",
  "qna.daily": "오늘의 질문 30개 (W210)",
  "qna.active.get": "진행 중 문답 불러오기 (H120, 목록 17번)",
  "qna.draft.get": "문답 임시 저장 불러오기 (H121, 목록 17번)",
  "qna.start": "첫 답변 → 문답 기록 만들기 (W210)",
  "qna.answer": "답변 → 후속 질문 (W210)",
  "qna.next": "다음 질문 다시 받기 (W210, AI 실패 뒤)",
  "qna.replace": "다른 질문 보기 (W210, 목록 12번 제안)",
  "qna.draft.save": "문답 임시 저장 (W211)",
  "qna.draft.revert": "이어 쓰기 되돌리기 (W211)",
  "qna.save": "AI 문답 → 소재로 저장 (W210)",
  "qna.discard": "진행 중 문답 지우기 (W211)",
  "analysis.start": "소재 분석 시작 (M120)",
  "analysis.get": "소재 분석 결과 (M120)",
  "material.confirm": "소재함에 보관 (M120)",
  "material.manual": "직접 정리하기 (M120, 목록 10번 제안)",
  "materials.list": "소재함 (M110)",
  "material.get": "소재 상세 (M130)",
  "settings.clear": "모든 기록 지우기 (S120)",
  "events.log": "이벤트 기록",
} as const;

export type MockKey = keyof typeof MOCK_KEYS;
