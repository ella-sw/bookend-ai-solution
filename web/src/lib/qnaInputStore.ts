/**
 * W210 입력칸에 적고 아직 보내지 않은 답변 (목록 9번). 이 브라우저의 localStorage에 대화별로 둔다.
 * 키: qnaInput:{record_id}. 첫 답변 전(record_id 없음)의 입력은 두지 않는다.
 * 저장이 막힌 환경이면 아무것도 하지 않는다 (입력칸은 그대로 쓸 수 있음).
 */
const PREFIX = "qnaInput:";

export function storeQnaInput(recordId: string, text: string) {
  try {
    if (text.trim()) window.localStorage.setItem(PREFIX + recordId, text);
    else window.localStorage.removeItem(PREFIX + recordId);
  } catch {
    // 무시
  }
}

export function loadQnaInput(recordId: string): string {
  try {
    return window.localStorage.getItem(PREFIX + recordId) ?? "";
  } catch {
    return "";
  }
}

export function removeQnaInput(recordId: string) {
  try {
    window.localStorage.removeItem(PREFIX + recordId);
  } catch {
    // 무시
  }
}

/** 모든 기록 지우기(S120) 뒤: 남은 입력을 모두 지운다 */
export function clearAllQnaInputs() {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    keys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // 무시
  }
}
