/**
 * JSON Schema 하위 스키마 위치 목록 — qgrid 의 스키마 순회 3곳이 공유하는 단일 정본.
 *
 *  - `tool-emulation-schema.rewriteSchemaNode`: 사용자 스키마의 local `$ref` 를 namespace 로 rebase
 *  - `strictifier.assertNormalizationCompatibility`: provider 표현 가능성 검사
 *  - `strictifier.strictifyNode`: strict 재작성
 *
 * 세 소비자가 각자 테이블을 들고 있으면 새 keyword 를 한쪽에만 추가하는 순간 조용히 어긋난다.
 * 재작성 패스가 훑지 않는 위치의 `$ref` 는 rebase 되지 않은 채 남고, 검사 패스가 놓친 위치의
 * tuple 은 정규화 없이 provider 로 샌다. 실제로 통합 전 `additionalItems` 가 그 상태였다.
 * 위치 목록은 여기서만 관리한다.
 *
 * 왜 이런 순회가 필요한지는 스킬 문서 참고:
 *   packages/cli/skills/qgrid/references/tool-calling-and-multiturn.md
 *
 * 소비자별로 다른 것은 위치 목록이 아니라 **각 위치를 어떻게 다루는가** 이므로(strictifier 의
 * `normalizable` 플래그 등) 그 판단은 각 소비자가 이 목록 위에 얹는다.
 */

/** 이름 → 하위 스키마 맵. 예: `properties`, `$defs`. */
export const SCHEMA_MAP_KEYWORDS = [
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
] as const;

/** 하위 스키마 배열. 예: `anyOf`, `prefixItems`. */
export const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

/**
 * 하위 스키마 하나를 직접 갖는 위치. `items` 와 `additionalItems` 는 Draft-7 tuple 형식에서
 * 배열이 올 수 있으므로 소비자가 배열 분기를 따로 처리한다.
 */
export const SCHEMA_SINGLE_KEYWORDS = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;

/**
 * Draft-7 `dependencies` 는 값이 스키마이거나 property 이름 배열이라 위 분류에 들어가지 않는다.
 * 배열 형태는 스키마가 아니므로 순회 대상이 아니다.
 */
export const SCHEMA_DEPENDENCIES_KEYWORD = "dependencies";

/**
 * qgrid 가 거부하는 참조/식별 keyword.
 *
 * 사용자 스키마는 envelope 의 `$defs` 아래로 옮겨지고 정의는 전역적으로 정규화되므로, base URI 를
 * 새로 선언하거나(`$id`) 런타임 스코프로 대상이 정해지는 참조(`$dynamicRef` 등)는 옮긴 뒤의 의미를
 * 보장할 수 없다. 조용히 잘못 rebase 하는 대신 명시적으로 거부한다.
 */
export const UNSUPPORTED_REFERENCE_KEYWORDS = [
  "$id",
  "id",
  "$anchor",
  "$dynamicAnchor",
  "$recursiveAnchor",
  "$dynamicRef",
  "$recursiveRef",
] as const;
