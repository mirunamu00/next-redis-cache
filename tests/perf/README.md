# perf

`scripts/perf.mjs`가 측정하고 이 디렉토리의 기준선과 비교한다(ROADMAP.md 6.5 perf 게이트).

- `baseline/<패키지 버전>.json` — 버전별 기준선. `--check`는 버전이 가장 높은 파일과 비교한다.
- 결정론 지표(하드 게이트): 요청당 Redis 명령 수(레거시 히트 `/docs/guide/doc-0`, use-cache 페이지 `/dyn/1`),
  static-site 빌드 1벌의 `MEMORY USAGE` 합(+5% 이내, 같은 Redis 마이너일 때만).
- 시간 지표(`--time`, autocannon 10초): p50/p99/req/s. +20% 초과는 경고만.
- `1.0.6.json`은 2026-09-29 로컬(Windows, Docker Desktop Redis 8.4.7, Next 16.3.6)에서 잰 값이다.
  명령 수·메모리는 플랫폼 무관(2회 측정 차이 171바이트), 시간 지표는 참고용이다.

기준선 갱신은 의도한 변화일 때만: `node scripts/perf.mjs --update-baseline --time` 후 커밋 메시지에 이유를 적는다.
릴리스 준비 중(작업 트리 version이 아직 이전 값)에는 `--as <새 버전>`으로 파일명을 정한다 — 이때 JSON에 `packageVersionField`(실제 package.json 값)가 함께 남는다.

## 기준선 이력

| 파일 | 레거시 히트 | use-cache 페이지 | static-site 1벌 | 바뀐 이유 |
|---|---|---|---|---|
| `1.0.6.json` | 3명령 | 8명령 | 123키 · 116,060,896B | 최초 기준선 |
| `1.1.0.json` | 3명령 | 8명령 | 178키 · 149,519,924B(+28.8%) | 7-4 프리워밍 수정: 1.0.6이 빠뜨리던 항목을 이제 저장한다 — 페이지 세그먼트(`/<page>/__PAGE__`) 129개 +29.8MB(1.0.6은 243개, 1.1.0은 372개), APP_ROUTE(OG 이미지·icon) 52개 +0.77MB, `/index`·`/_not-found`·`/_global-error` 3개. 요청당 명령 수·키 형식은 불변 |
