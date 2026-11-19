/**
 * 이 화면이 뒤로/앞으로 가기(popstate)로 열렸는지 알려 준다 (목록 7번: 끝난 글쓰기 흐름으로 뒤로 가지 않게).
 * 루트 layout의 NavDirectionListener가 installNavDirection()을 1번 부른다.
 *
 * - popstate가 오면 '뒤로/앞으로 가기로 열림' = true (그때의 주소를 기억)
 * - push·replace로 다른 주소가 열리면 false.
 *   Next 라우터는 뒤로 가기로 화면을 되살린 뒤에도 같은 주소로 replaceState를 부르므로, 주소가 같으면 그대로 둔다.
 *   팝업·나가기 확인이 쌓는 기록(pushState(…, "")도 주소가 같아서 그대로 둔다.
 *
 * 나가는 중 표시 (exit chain): 끝난 흐름에서 내 서재(L110)로 보낸 뒤에는 다음 뒤로 가기가
 * 남은 흐름 화면(N120·N110 …)과 같은 L110을 건너뛰고 흐름 시작 전 화면까지 가게 한다.
 * - 새 주소로 push하면 끝, 흐름·내 서재가 아닌 화면에 뒤로/앞으로 가기로 닿아도 끝.
 * - 건너뛰며 한 칸 뒤로 갔는데 같은 주소의 기록에 닿으면(나가기 확인·팝업이 쌓은 기록) 화면이 다시 그려지지 않으므로
 *   여기서 한 칸 더 뒤로 간다.
 */

let installed = false;
let traversal = false;
let traversalHref: string | null = null;
let exitChain = false;
/** 건너뛰기로 뒤로 간 화면의 주소 (같은 주소에 닿으면 한 칸 더) */
let skippingFrom: string | null = null;

const toHref = (url: string | URL | null | undefined) => (url ? new URL(url, window.location.href).href : window.location.href);

/** 나가는 중 표시를 이어 가는 화면: 새 글 쓰기 흐름(/new…)과 내 서재(/library) */
function keepsExitChain(pathname: string) {
  return pathname === "/new" || pathname.startsWith("/new/") || pathname === "/library";
}

export function installNavDirection() {
  if (installed || typeof window === "undefined") return;
  installed = true;

  window.addEventListener("popstate", () => {
    traversal = true;
    traversalHref = window.location.href;
    if (!keepsExitChain(window.location.pathname)) exitChain = false;
    const from = skippingFrom;
    skippingFrom = null;
    if (from === window.location.href && exitChain) {
      traversal = false;
      skipBack();
    }
  });

  // Next 라우터도 이 함수를 감싸지만, 어느 쪽이 먼저 감싸든 모든 호출이 여기를 지난다
  const pushState = window.history.pushState;
  const replaceState = window.history.replaceState;
  window.history.pushState = function (data: unknown, unused: string, url?: string | URL | null) {
    const href = toHref(url);
    if (href !== traversalHref) traversal = false;
    if (href !== window.location.href) exitChain = false;
    return pushState.call(this, data, unused, url);
  };
  window.history.replaceState = function (data: unknown, unused: string, url?: string | URL | null) {
    if (toHref(url) !== traversalHref) traversal = false;
    return replaceState.call(this, data, unused, url);
  };
}

/** 지금 화면이 뒤로/앞으로 가기로 열렸으면 true (push·replace로 열렸으면 false) */
export function openedByHistoryTraversal() {
  return typeof window !== "undefined" && traversal && traversalHref === window.location.href;
}

/**
 * 이번 뒤로/앞으로 가기를 처리했다고 표시한다 (그 뒤 openedByHistoryTraversal()은 false).
 * 개발 모드에서 effect가 두 번 돌아도 한 번만 처리하게 한다
 */
export function markTraversalHandled() {
  traversal = false;
}

/** 끝난 흐름에서 내 서재로 보낼 때 표시 */
export function startExitChain() {
  exitChain = true;
}

export function inExitChain() {
  return exitChain;
}

/** 나가는 중에 지금 화면을 건너뛰고 한 칸 더 뒤로 간다 */
export function skipBack() {
  skippingFrom = window.location.href;
  window.history.back();
}
