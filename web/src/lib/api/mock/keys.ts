/**
 * 목업 응답 이름표. API 함수 하나 = 키 하나.
 * /dev/mock 화면에서 키마다 상황(정상·실패·시간 초과·소재 없음·느림)을 고를 수 있다.
 */
export const MOCK_KEYS = {
  "user.start": "첫 실행 동의 (O110)",
  "home.get": "홈 데이터 (H110)",
  "topics.list": "주제 목록",
  "records.draft.get": "임시 저장 불러오기 (H121)",
  "records.draft.save": "임시 저장 (W111)",
  "records.save.free": "자유 기록 → 소재로 저장 (W110)",
  "records.save.qna": "AI 문답 → 소재로 저장 (W210)",
  "records.keep": "원본만 보관 (M120)",
  "records.delete": "기록 삭제 (M132)",
  "qna.start": "첫 답변 → 문답 기록 만들기 (W210, 목록 17번)",
  "qna.daily": "오늘의 질문 30개 (W210)",
  "qna.answer": "답변 → 후속 질문 (W210)",
  "qna.replace": "다른 질문 보기 (W210, 목록 12번 제안)",
  "qna.discard": "저장하지 않고 나가기 (W211)",
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
