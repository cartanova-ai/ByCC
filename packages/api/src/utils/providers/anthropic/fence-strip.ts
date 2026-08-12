/**
 * 코드펜스 스트리핑 (SON-532).
 *
 * anthropic 은 스키마/envelope 계약을 프롬프트로 안내하므로 응답은 평범한 텍스트다.
 * sonnet 계열이 지시에도 불구하고 ```json 펜스를 붙이는 실측이 있어, 서버가 펜스와
 * 양끝 공백만 벗겨 소비자(zod)/parseEnvelope/EnvelopeStreamParser 에 순수 JSON 을
 * 넘긴다. 머리말·후미 프로즈 구제는 하지 않는다 — 관용 복구는 2026-07 medpath 13.5k
 * 오염 사고로 기각된 원칙이며, 프로즈 응답은 다음 층에서 정직하게 실패한다.
 *
 * `stripFences` 는 stream-json-adapter 의 stripCodeFence(비스트림 result 경로)에서
 * 추출한 동일 시맨틱이다 — 스트림 델타 연결과 비스트림 최종 텍스트가 같은 결과여야
 * 클라이언트가 어느 쪽을 조립해도 어긋나지 않는다.
 */

export function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "");
}

interface FenceStripTransform {
  /** delta 를 넣고 지금 방출해도 안전한 조각을 돌려받는다. */
  push(delta: string): string;
  /** 스트림 종료. 보류분 중 펜스·trailing 공백이 아닌 잔여를 돌려준다. */
  flush(): string;
}

/**
 * 델타 스트림용 통과 필터. 불변식: 임의 절단 지점에 대해
 * `push(...) 들의 연결 + flush() == stripFences(전체 텍스트)`.
 *
 * tail 홀드백은 고정 크기가 아니라 계약 기반이다 — "공백·개행·백틱만으로 이루어진
 * suffix"(닫는 펜스 후보)를 스트림 완료까지 보류하고, 후보를 깨는 내용이 오면 즉시
 * 방출을 재개한다. 닫는 펜스 앞 공백은 임의 길이일 수 있어 고정 크기로는 "양끝 공백
 * 제거" 불변식이 성립하지 않는다.
 */
export function createFenceStripTransform(): FenceStripTransform {
  let full = "";
  // full 에서 본문(leading trim + 여는 펜스 이후)이 시작하는 인덱스. -1 = 아직 미확정.
  let bodyStart = -1;
  // 본문 기준으로 이미 방출한 문자 수. 방출분은 최종 결과의 prefix 임이 보장된다 —
  // 공백은 비공백 내용이 뒤따르기 전까지 항상 보류되므로, 나중에 닫는 펜스의 일부로
  // 판명될 문자가 미리 방출되는 일이 없다.
  let emitted = 0;

  return {
    push(delta: string): string {
      full += delta;
      if (bodyStart < 0) {
        bodyStart = resolveLeadingOffset(full);
        if (bodyStart < 0) return "";
      }

      const body = full.slice(bodyStart);
      const unemitted = body.slice(emitted);
      const safe = unemitted.length - trailingHoldLength(unemitted);
      if (safe <= 0) return "";

      const out = unemitted.slice(0, safe);
      emitted += safe;
      return out;
    },

    flush(): string {
      // 방출분이 최종 결과의 prefix 라는 불변식 위에서, 잔여만 잘라 돌려준다.
      return stripFences(full).slice(emitted);
    },
  };
}

/**
 * 여는 펜스 판정. 아직 "```json" 으로 자랄 수 있는 경계(백틱 1~2개, "```j(s(o))",
 * 펜스 직후 공백만 도착)면 -1 로 보류한다. stripFences 의 leading 정규식과 동일한
 * 소비 규칙: ```(json)? 뒤에 이어지는 공백 전부가 펜스에 붙어 떨어져 나간다.
 */
function resolveLeadingOffset(text: string): number {
  const trimmedStart = text.trimStart();
  if (trimmedStart === "") return -1; // 아직 공백뿐 — flush 가 정리한다
  const ws = text.length - trimmedStart.length;

  if (!trimmedStart.startsWith("`")) return ws;
  if (/^`{1,2}$/.test(trimmedStart)) return -1; // "```" 로 자랄 수 있음

  const fence = /^```(?:json)?/i.exec(trimmedStart);
  if (!fence) return ws; // "`x", "``x" — 펜스가 아니라 본문
  if (/^```(?:j|js|jso)$/i.test(trimmedStart)) return -1; // "json" 태그가 자라는 중

  const afterFence = trimmedStart.slice(fence[0].length);
  const afterFenceBody = afterFence.trimStart();
  if (afterFenceBody === "") return -1; // 펜스 뒤 공백만 — 본문 첫 글자 대기
  return ws + fence[0].length + (afterFence.length - afterFenceBody.length);
}

/**
 * 아직 방출하면 안 되는 suffix 길이. 닫는 펜스 후보는 "(개행?)(백틱 1~3)(공백*)" 또는
 * 순수 trailing 공백 — stripFences 의 trim + /\n?```\s*$/ 가 지울 수 있는 모든 형태를
 * 덮는다. 미방출 구간에만 적용하므로 정규식 비용은 (보류분 + delta) 크기에 비례한다.
 */
function trailingHoldLength(unemitted: string): number {
  const match = /(?:\n?`{1,3})?[ \t\r\n]*$/.exec(unemitted);
  return match ? match[0].length : 0;
}
