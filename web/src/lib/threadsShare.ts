export const THREADS_LIMIT = 500;

// Threads는 이모지에 UTF-8 바이트 길이를 사용한다. 조합 이모지는 나누지 않는다.
const emoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}]/u;
const encoder = new TextEncoder();

export function threadsTextLength(text: string): number {
  return Array.from(text).reduce((length, char) => length + (emoji.test(char) ? encoder.encode(char).length : 1), 0);
}

export function threadsIntentUrl(text: string): string {
  return `https://www.threads.com/intent/post?text=${encodeURIComponent(text)}`;
}

/** 전체 내용을 보존하며 글자 제한 안에서 나눈다. 번호에 쓸 여유를 남긴다. */
export function splitThreadsText(text: string): string[] {
  if (threadsTextLength(text) <= THREADS_LIMIT) return [text];
  const segments = new Intl.Segmenter("ko", { granularity: "grapheme" }).segment(text);
  const parts: string[] = [];
  let chunk = "";
  let length = 0;
  for (const { segment } of segments) {
    const size = threadsTextLength(segment);
    if (length + size > THREADS_LIMIT - 20 && chunk) {
      parts.push(chunk);
      chunk = "";
      length = 0;
    }
    chunk += segment;
    length += size;
  }
  if (chunk) parts.push(chunk);
  return parts.map((part, index) => `(${index + 1}/${parts.length})\n${part}`);
}
