# perf

`scripts/perf.mjs`가 측정하고 이 디렉토리의 기준선과 비교한다(ROADMAP.md 6.5 perf 게이트).

- `baseline/<패키지 버전>.json` — 버전별 기준선. `--check`는 버전이 가장 높은 파일과 비교한다.
- 결정론 지표(하드 게이트): 요청당 Redis 명령 수(레거시 히트 `/docs/guide/doc-0`, use-cache 페이지 `/dyn/1`),
  static-site 빌드 1벌의 `MEMORY USAGE` 합(+5% 이내, 같은 Redis 마이너일 때만).
- 시간 지표(`--time`, autocannon 10초): p50/p99/req/s. +20% 초과는 경고만.
- `1.0.6.json`은 2026-09-29 로컬(Windows, Docker Desktop Redis 8.4.7, Next 16.3.6)에서 잰 값이다.
  명령 수·메모리는 플랫폼 무관(2회 측정 차이 171바이트), 시간 지표는 참고용이다.

기준선 갱신은 의도한 변화일 때만: `node scripts/perf.mjs --update-baseline --time` 후 커밋 메시지에 이유를 적는다.
