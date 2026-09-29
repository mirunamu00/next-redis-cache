# @mirunamu/next-redis-cache 고도화 로드맵

이 문서는 패키지 고도화의 **기준 문서**다. 모든 작업 세션은 이 문서를 먼저 읽고, 결정이 바뀌면 이 문서를 갱신한다.
npm 게시물에는 포함되지 않는다(`package.json`의 `files`는 `dist`만 — `scripts/check-pack.mjs`가 강제).

- 작성: 2026-09-29 (1.0.6 기준 감사 → 계획 → 테스트 환경 재설계를 합친 것)
- 대상 버전: 1.0.6(현재) → 1.1.0(핫픽스) → 2.0.0
- 레퍼런스 소비자: `mirunamu-cluster/docs` 앱(docs.mirunamu.info). 단, **모든 검증은 이 레포 안의 테스트 환경에서** 하고 docs는 롤아웃 스모크만 맡는다.

---

## 1. 현재 상태 요약 (1.0.6)

| 항목 | 내용 |
|---|---|
| 공개 API | `.` → `LegacyCacheHandler`(named+default), 타입 `LegacyHandlerConfig`·`OnCreationHook`·`RedisHandlerOptions`·`ResolvedRedisOptions` / `./use-cache` → `createUseCacheHandler` / `./instrumentation` → `registerInitialCache`·`cleanupOldBuildKeys` |
| peer | `next >=15.0.0`, `@redis/client >=5.0.0` (dependencies 없음) |
| 빌드 | tsup ESM `.js` + CJS `.cjs` + `.d.ts`/`.d.cts`, target node18. exports의 `types`가 조건 없이 `.d.ts`만 가리킴 |
| 테스트 | **없음** (테스트 앱은 1.0.3에서 삭제) |
| 게시 | changesets/action + `NPM_TOKEN`. npm 1.0.6 = 레포 1.0.6 = docs 설치본(로컬 dist와 바이트 동일 확인) |
| 사용량 | npm 월 4,398 다운로드(2026-08-29~09-27) — docs CI만으로 설명 어려움 → 외부 사용자 가능성 |

### 1.1 모듈과 동작

- `legacy-handler.ts` — 정적 상태를 가진 CacheHandler 클래스. `onCreation(hook)` 등록 → 첫 호출 때 1회 초기화. get: GET → Buffer 복원 → `HEXISTS` 고아 검사 → `lifespan.expireAt` 검사 → `HMGET revalidated`로 태그 판정. set: `SET EX [NX]` + `HSET tags` + `HSET ttl`을 `Promise.all`(원자적 아님). revalidateTag: 태그 Hash 전체 `HSCAN` 후 해당 키 UNLINK, 암묵 태그(`_N_T_`)만 시각 기록.
- `use-cache-handler.ts` — 팩토리. get: pending set 대기 → GET → `now > timestamp+revalidate*1000`이면 미스 → soft/entry 태그 HMGET 2회. set: tee → base64 → `SET EX`. `updateTags`: durations 있으면 `now + expire*1000` 기록.
- `tag-manager.ts` — Hash 3종(`{prefix}{sharedTagsKey}` cacheKey→태그 JSON, `{prefix}{sharedTagsTtlKey}` cacheKey→만료초, `{prefix}{revalidatedTagsKey}` tag→ms). 전부 TTL 없음.
- `instrumentation.ts` — `registerInitialCache`(prerender-manifest v4 → 디스크 → `set NX`), `cleanupOldBuildKeys`(SCAN → 메모리에 모두 모아 `DEL` 한 번).
- `redis-client.ts` — `assertClientReady`(isReady만), `withTimeout`(Promise.race, 타이머 해제 안 함).
- 오류 로그는 `NEXT_PRIVATE_DEBUG_CACHE`일 때만 남는다.

### 1.2 Next.js 인터페이스 사실 (소스로 확인)

- Next 16.1.6 = 16.3.6 `CacheHandler`: `get(key, softTags)`, `set(key, pendingEntry)`, `refreshTags()`, `getExpiration(tags[])`, `updateTags(tags, durations?)`.
- Next 15.5.26 `CacheHandlerV2`: `getExpiration(...tags)`(가변), `expireTags(...tags)` — `updateTags` 없음 → **현 패키지는 Next 15에서 use-cache가 올바르게 동작하지 않는다.**
- `revalidateTag(tag, profile)`(16): `revalidation-utils.js`가 `updateTags(tags, {expire: cacheLife.expire})` 호출('max' = 1년). profile 없으면 `updateTags(tags)`(즉시 만료).
- 기본 핸들러 의미론: `updateTags(durations)` = `stale=now`, `expired=now+expire*1000`. `areTagsExpired`: `expired ≤ now && expired > ts`. `areTagsStale`: `stale > ts`.
- use-cache SWR: `use-cache-wrapper.js`가 revalidate 지난(expire 전) 항목을 받으면 응답 후 백그라운드 재생성. 16.3.6 기본 핸들러는 stale 태그면 `revalidate:-1`, 음수 `expire`는 퇴거 표식.
- 레거시 SWR: 핸들러가 `lastModified:-1`을 주면 `IncrementalCache`가 isStale=-1 → response-cache가 기존 값 응답 + 백그라운드 재생성. **null을 주면 `dynamicParams=false` 경로는 404**(docs 운영 사고).
- `getExpiration`이 `Infinity`를 반환하면 Next는 암묵 태그를 `get(softTags)`에 맡긴다.

---

## 2. 감사 결과 — 문제 목록 (7-1 ~ 7-13)

| ID | 심각도 | 문제 | 근거(1.0.6) |
|---|---|---|---|
| 7-1 | 높음 | `revalidateTag(tag,'max')` → `updateTags(durations)`가 **미래 시각**(`now+1년`)을 기록 → 해당 태그의 use-cache·레거시 항목이 1년간 매번 stale/삭제(캐시 사실상 비활성). 공유 Hash라 레거시 `isStale`도 오염 | `tag-manager.ts:196-198`, `use-cache-handler.ts:107-122`, `tag-manager.ts:66-80` |
| 7-2 | 높음 | README 예시대로 `await client.connect()` 하면(v5 기본 무한 재연결) Redis 다운 시 hook이 끝나지 않아 **모든 get/set 무한 대기**. `cleanupOldBuildKeys`도 연결 타임아웃 없음. hook 예외는 try 밖이라 Next로 전파 | `legacy-handler.ts:148,201,277`, `instrumentation.ts:252`, README |
| 7-3 | 중간 | use-cache 경로가 `exec(client.get(...))` — 명령을 **먼저 보내고** isReady 검사. 재연결 중이면 offline queue 무한 적재, 소켓이 닫혀 있으면 rejected promise가 핸들러 없이 버려져 **unhandledRejection → 프로세스 종료** | `use-cache-handler.ts:78-81,96,191`, `tag-manager.ts:29-32`, `@redis/client client/index.js:638-640` |
| 7-4 | 중간 | 프리워밍: ① 세그먼트 Map 키가 Next(`/_tree`, `/about/__PAGE__`)와 다름(`_tree`, `about/__PAGE__`) → prefetch 204 ② `/`가 `app/.html`로 누락 ③ `dataRoute` 없는 route를 건너뛰어 APP_ROUTE 분기가 죽은 코드 ④ meta `status`·`postponed` 유실 | `instrumentation.ts:126,135,63,208,88-89` |
| 7-5 | 중간 | 값은 EX로 사라져도 태그·TTL Hash 필드는 영구 잔존. `cleanupExpired`·`deleteTags`는 호출처 없음. `revalidateTag`는 Hash 전체 O(N) 스캔 + JSON.parse(깨진 필드 하나면 전체 중단) | `tag-manager.ts:55,127,97-115` |
| 7-6 | 중간 | 레거시 `revalidateTag`가 `durations` 무시하고 즉시 삭제만 → Next 16 SWR 의미와 불일치, `dynamicParams=false` 404 위험. 명시 태그는 시각 미기록 → 렌더 중 무효화 시 옛 데이터 부활 레이스 | `legacy-handler.ts:350-369` |
| 7-7 | 중간 | 모든 오류 로그가 debug 게이트 뒤 → 운영에서 set·무효화 실패가 무음 | `legacy-handler.ts:266-268,345-347,365-367` |
| 7-8 | 중간 | Next 15 호환 주장(README·peer)이 검증되지 않았고 실제로 인터페이스 불일치(1.2절) | `package.json:42`, README |
| 7-9 | 낮음~중간 | `cleanupOldBuildKeys`: 전량 메모리 수집 후 단일 `DEL`(블로킹, README의 non-blocking 주장과 모순), 중복 집계, deprecated `disconnect()`, `keepPrefix`로 롤링 중 옛 Pod 키 삭제 | `instrumentation.ts:255-279` |
| 7-10 | 낮음 | `withTimeout` 타이머 미해제 → 호출마다 5초 타이머 잔존, 종료 지연 | `redis-client.ts:15-20` |
| 7-11 | 낮음 | APP_ROUTE는 `ctx.cacheControl` 미참조 → Next 16에서 항상 기본 1년×1.5 TTL. use-cache는 revalidate 지나면 버리면서 TTL은 expire 기준(쓸모없는 데이터 체류). TTL이 lastModified 기준이라 오래된 빌드의 재시드가 즉시 만료 | `legacy-handler.ts:101`, `use-cache-handler.ts:98-102,183-186` |
| 7-12 | 낮음 | set 3명령 비원자·NX 스킵이어도 Hash 덮어씀. 다른 Pod에서 값 기록과 HSET 사이의 get이 방금 쓴 값을 고아로 삭제 가능. 같은 키 set 중첩 시 앞 set의 finally가 뒤 set의 pending을 지움 | `legacy-handler.ts:335-342`, `use-cache-handler.ts:196-197` |
| 7-13 | 낮음 | README 불일치: in-flight 중복 제거 과장, 전 호출 타임아웃 주장, 기본 `uc:` 프리픽스가 keyPrefix 밖, `cacheLife("hours")` 값 오기, App Route 프리워밍 미동작, `LICENSE` 파일 부재, 보안(Redis 쓰기 권한 = 캐시 오염 권한) 언급 없음, Action이 태그 고정 | README 각처 |

### 2.1 P0c~P0d에서 새로 확인한 사실

- **빈 Redis에서 prerender 경로 404(A2)**: 1.0.6 + Redis 연결 정상 + 키 없음 → `dynamicParams=false` 페이지가 404(Next가 null을 받으면 NoFallbackError). docs의 프리워밍 의존·운영 사고와 같은 경로다. 프리워밍을 켜도 `dynamicParams=false` 페이지는 무효화 뒤(7-6)·키 유실 뒤(C6)·롤링 중 정리 뒤(C11·C12)에 그대로 404다.
- **세그먼트 prefetch 미스는 16.3.6에서 404**(1절·7-4의 "204"는 이전 버전 관찰). 프리워밍 키 형식이 틀리면 404, Next가 직접 렌더해 저장한 항목은 200.
- **프리워밍이 `/_`로 시작하는 라우트를 통째로 건너뛴다**(`/_not-found`) — 7-4의 "not-found status 유실"은 실제로는 "아예 프리워밍 안 됨"이다.
- **7-3은 기본 재연결 클라이언트에서도 터진다**: 트래픽 중 Redis가 3초 끊기면 unhandledRejection 165~171건. 핸들러가 명령을 먼저 보내고 ready 검사에서 버린 promise 중 일부가 재연결 실패 때 거절되는 것으로 추정한다(나머지는 offline queue에 남았다가 복구 후 재전송, 3~22건 관측).
- **레거시 클래스 타입 비호환**: `LegacyCacheHandler`는 Next `CacheHandlerContext`로 생성되는 클래스 타입에 대입되지 않는다(자체 context 타입의 index signature). 7-8에 포함, contract-types가 `@ts-expect-error`로 추적.
- `@redis/client` **6.2.1이 출시**됐다. peer `>=5.0.0`은 검증되지 않은 6.x를 허용한다(9절 리스크).

---

## 3. 목표와 수용 기준

**목표**: Next 16의 두 캐시 인터페이스를 의미론까지 정확히 구현하고, Redis 장애·지연·부재·축출에서도 정적 페이지가 404 없이 응답하며, Redis 메모리를 한정하고, 이 모두를 레포 내장 회귀 테스트로 고정한다. docs 래퍼(526줄)를 설정 수준으로 축소한다.

**비목표**: ioredis, Redis Cluster·Sentinel, Pages Router 고급 기능, Edge 런타임, Next 15의 use-cache.

| # | 수용 기준 | 측정 위치 |
|---|---|---|
| A1 | 7-1~7-12 각각 1.0.6에서 실패하는 테스트 존재, 2.0에서 전부 통과 | vitest `it.fails` → 일반 전환 |
| A2 | Redis 없이 기동 → 첫 응답 < 2s, 모든 prerender 경로 200 | static-site e2e + chaos C1 |
| A3 | Redis 무응답 중 요청 지연: 첫 1회 ≤ readTimeout, circuit open 동안 ≤ 50ms 추가 | chaos C3 |
| A4 | 장애 주입 전체에서 `unhandledRejection` 0, 복구 후 offline queue 폭주 0 | fault + chaos |
| A5 | 배포 10회 시뮬레이션 후 키 수 ≤ (보존 빌드 × 페이지) + 태그 수, TTL 없는 키는 `_tagstate`·`_builds` 2개뿐 | integration + fleet |
| A6 | 프리워밍/재시드된 모든 페이지의 세그먼트 prefetch 200 | static-site e2e |
| A7 | `revalidateTag(t,'max')` 후 다음 요청 stale 응답+1회 재생성, 이후 히트. `updateTag(t)`는 즉시 미스 | full-cc / full-legacy e2e |
| A8 | 인스턴스 2개 공유 Redis에서 한쪽 무효화가 다른 쪽 다음 요청에 반영 | fleet e2e |
| A9 | 빌드 1벌 Redis 메모리 50% 이상 감소(압축 옵션) | static-site perf |
| A10 | docs 캐시 코드 ≤ 약 40줄, `resilient-cache-handler.mjs`·`redis-connect.mjs`·`build-keys.mjs` 제거 | docs PR |

---

## 4. 버전 전략

- **1.1.0 핫픽스 먼저**(스키마 불변): 7-1(now 기록), 7-3(thunk 실행), 7-4(세그먼트 키·`/index`·APP_ROUTE·status), 7-9(배치 UNLINK·`destroy`·연결 타임아웃), 7-10(`clearTimeout`), 오류 warn 로깅, LICENSE, exports types. 외부 사용자 즉시 이득 + OIDC 게시 파이프라인 실검증.
- **2.0.0 메이저**: 키 스키마·저장 형식, 옵션 체계(`keyPrefix` → `namespace`+`buildId`, `sharedTagsKey`/`sharedTagsTtlKey` 폐지), 팩토리 API(정적 클래스 폐기), peer `next ^16.1`·`@redis/client ^5`, `engines.node >=20.9`, instrumentation API 교체.
- **무중단 전환**: 값 키는 빌드 ID 범위라 새 이미지는 새 키 공간을 쓴다(옛 v1 Pod와 공존). v2 키도 `{ns}:{buildId}:…`(두 번째 세그먼트 = 소유자)를 유지해 v2 정리가 v1 옛 빌드 키(`docs:<sha>:/about`)를 같은 규칙으로 치운다. 빌드 무관 전역 키는 `_` 예약 소유자(`{ns}:_builds`, `{ns}:_tagstate`)이며 정리 대상에서 제외. 저장 엔벨로프에 형식 버전을 넣고 모르는 버전은 미스 처리.
- 리스크: 전환 후 v1 이미지로 롤백하면 v1 docs 정리(`build-keys.mjs`)가 `_tagstate`를 옛 빌드로 보고 30분 idle 시 삭제 — docs는 태그 무효화를 안 써서 무해, 문서화.

---

## 5. 목표 아키텍처 (2.0)

### 5.1 키 스키마

| 키 | 타입 | TTL | 내용 |
|---|---|---|---|
| `{ns}:{build}:e:{cacheKey}` | String(바이너리 엔벨로프) | 항상 | 레거시 항목 |
| `{ns}:{build}:u:{cacheKey}` | String(바이너리 엔벨로프) | 항상 | use-cache 항목 |
| `{ns}:_tagstate` | Hash tag → `"{stale},{expired}"`(ms) | 없음(태그 수로 한정). Redis ≥7.4면 선택적 HEXPIRE | 두 핸들러 공유 태그 상태 |
| `{ns}:_builds` | ZSET | 없음 | 빌드 레지스트리 |

- **태그→키 역인덱스 폐지, lazy 무효화만**(Next 기본 핸들러와 동일) → 7-5 구조적 해소.
- 태그 상태는 **네임스페이스 전역**(데이터 무효화는 옛 빌드 Pod에도 적용되어야 함).
- 엔벨로프: `[magic+ver][메타 JSON 길이][메타 JSON][blob…]` — Buffer·Map 세그먼트를 base64 없이 저장, 선택적 gzip/brotli. 읽기는 `withTypeMapping({[RESP_TYPES.BLOB_STRING]: Buffer})`.

### 5.2 의미론 (Next 16)

- `updateTags(tags, durations?)` = 레거시 `revalidateTag(tags, durations?)` = 같은 함수: durations 없음 → `expired=now`; 있음 → `stale=now, expired=now+expire*1000`. 두 핸들러가 멱등 HSET. **키 삭제 없음.**
- 태그 판정은 Next의 `areTagsExpired`/`areTagsStale`를 그대로 이식.
- use-cache `get`: `expire<0`(퇴거 표식)·`now > ts+expire*1000`·태그 expired → 미스 / stale 태그 → `revalidate:-1` / revalidate만 지남 → 그대로 반환(Next SWR). `swr:false`면 현행.
- `getExpiration` → `Infinity`(암묵 태그는 `get(softTags)`에서 1회 판정). 16.1·16.3 fixture로 검증 후 확정.
- 레거시 `get`: softTags가 있으면 GET+HMGET 파이프라인 → 저장 태그 잔여분 HMGET(최대 2왕복). FETCH+expired → null. APP_PAGE/APP_ROUTE/PAGES는 expired·stale → `lastModified:-1`(SWR). 옵션 `onTagExpired:"stale"|"miss"`(기본 stale). HEXISTS 고아 검사·`lifespan.expireAt` 검사 제거.
- TTL: **기록 시점 기준**. revalidate 숫자 → `estimateExpire(revalidate)`(기본 1.5배), `false` → `ttl.staticSeconds`(기본 30일), 전부 `ttl.maxSeconds` 상한. APP_ROUTE는 `ctx.cacheControl` 참조.
- `pendingSets`는 set별 토큰으로 관리. Redis 저장 시 불필요한 `tee` 제거.

### 5.3 연결·타임아웃·circuit·로깅

- 모든 명령은 `run(op, () => client.cmd(...))` 한 곳을 통과: circuit open 또는 `!isReady` → **명령을 보내지 않고** unavailable. 해제되는 타이머로 타임아웃(5.10의 명령 `timeout` 옵션 병행은 확인 후). 타임아웃 1회 → `openMs` 동안 open.
- `client`는 인스턴스 또는 `() => client|null`. 패키지는 `connect()`를 await하지 않는다. `./redis`의 `connectRedis(url,{waitMs=1000})` 제공(늦어도 클라이언트 반환, 끊김/복구 전이 로그). globalThis 심볼로 클라이언트 1개 공유.
- `logger` 옵션(기본 console warn/error, debug는 `NEXT_PRIVATE_DEBUG_CACHE`), 전이 시에만 기록 + 주기 요약. `onEvent` 훅(hit/miss/stale/fallback/reseed/error/circuit).
- 기본 `disabled` = `NEXT_PHASE === "phase-production-build"` → 내장 no-op.

### 5.4 빌드 산출물(디스크) 폴백 흡수

- APP_PAGE·APP_ROUTE, `!dev && !disabled && serverDistDir`일 때. Next `FileSystemCache`를 읽기 전용(`flushToDisk:false`, `maxMemoryCacheSize:0`)으로 사용 — Next 버전 형식을 자동 추종. 내부 경로 의존은 동적 import 가드 + 매트릭스 계약 테스트.
- 디스크 항목도 태그 상태로 판정: stale → `lastModified:-1`, fresh → NX 재시드(revalidate는 prerender-manifest, `/`→`/index`).
- 프리워밍은 같은 경로로 재작성(7-4 구조적 해소). 폴백+재시드가 있으면 프리워밍은 선택이며 기본 off.

### 5.5 옛 빌드 정리 흡수

docs `build-keys.mjs` 알고리즘 이식: 레지스트리 ZSET, 현재+직전 N개 보존, 그 외는 모든 키 `OBJECT IDLETIME ≥ minIdleSeconds`일 때만 배치 UNLINK, 보류·직전 빌드는 TTL 상한, `cleanupWhenReady`(ready 대기 + 지수 백오프). `_*` 소유자 제외. v1 `cleanupOldBuildKeys`는 수정 후 2.x deprecated, 3.0 제거.

### 5.6 공개 API 초안

```ts
// "@mirunamu/next-redis-cache"
export interface RedisCacheConfig {
  client: RedisClientType | (() => RedisClientType | null | Promise<RedisClientType | null>);
  namespace: string;                                   // 필수
  buildId?: string;                                    // 기본 process.env.BUILD_ID ?? <distDir>/BUILD_ID
  timeouts?: { readMs?: number; writeMs?: number };    // 기본 1000 / 2000
  circuitBreaker?: { openMs?: number } | false;        // 기본 { openMs: 10_000 }
  fallback?: { buildOutput?: boolean; reseed?: boolean } | false; // 기본 true/true(prod)
  ttl?: { staticSeconds?: number; maxSeconds?: number; estimateExpire?: (revalidateSec: number) => number };
                                                       // 기본 30일 / 365일 / s => Math.floor(s*1.5)
  onTagExpired?: "stale" | "miss";                     // 기본 "stale"
  compression?: "none" | "gzip" | "brotli";            // 기본 "none"(P6 재평가)
  logger?: Partial<Record<"debug"|"info"|"warn"|"error", (...a: unknown[]) => void>> | false;
  onEvent?: (e: CacheEvent) => void;
  disabled?: boolean | (() => boolean);                // 기본: 빌드 페이즈
}
export function createCacheHandler(config: RedisCacheConfig): new (ctx: unknown) => LegacyCacheHandlerInstance;
// "@mirunamu/next-redis-cache/use-cache"
export function createUseCacheHandler(config: RedisCacheConfig & { swr?: boolean; tagStateCacheMs?: number }): CacheHandler;
// "@mirunamu/next-redis-cache/redis"
export function connectRedis(url: string | undefined, o?: { waitMs?: number; label?: string; clientOptions?: RedisClientOptions; logger?: Logger }): Promise<RedisClientType | null>;
// "@mirunamu/next-redis-cache/instrumentation"
export function startCacheMaintenance(o: { config: RedisCacheConfig;
  cleanup?: { keepPrevious?: number; minIdleSeconds?: number; retiredTtlSeconds?: number; attempts?: number } | false; // 1 / 1800 / 86400 / 10
  prewarm?: boolean | { concurrency?: number } /* 기본 false */ }): { done: Promise<MaintenanceResult> };
export function cleanupOldBuilds(client: RedisClientType, o: CleanupOptions): Promise<CleanupResult>;
export function prewarmFromBuildOutput(config: RedisCacheConfig, o?: { concurrency?: number }): Promise<{ prewarmed: number; skipped: number; failed: number }>;
/** @deprecated */ export function cleanupOldBuildKeys(...): ...;
```

### 5.7 docs 래퍼 처리 (P5)

| docs 코드 | 처리 |
|---|---|
| 디스크 폴백, 태그 판정+`lastModified:-1`, NX 재시드, 무응답 circuit (`cache/resilient-cache-handler.mjs`) | 흡수 |
| 명시 태그 시각 기록, 자체 `withTimeout` | 버림(v2가 대체) |
| `connectRedis`·`isBuildPhase` (`cache/redis-connect.mjs`) | 흡수 |
| 레지스트리 정리·`cleanupWhenReady` (`cache/build-keys.mjs`) | 흡수. 한국어 로그 포매터는 docs 선택 |
| REDIS_URL 누락 배너 (`src/instrumentation-node.ts`) | docs 유지 |
| 백그라운드 cleanup/prewarm 조율 | 흡수(`startCacheMaintenance`) |
| use-cache no-op (`use-cache-handler.mjs`) | 흡수 |
| `tests/unit/*`, `mini-redis.mjs` | 패키지로 포팅(P0), docs에서는 래퍼와 함께 삭제 |

docs 최종: `cache/config.mjs`(namespace·BUILD_ID·`connectRedis`·`CACHE_NAMESPACE` 덮어쓰기) + 핸들러 파일 각 3줄 + instrumentation 배너·`startCacheMaintenance({prewarm:false})`. 버전은 프리릴리스 동안 정확 고정(`2.0.0-next.N`), 안정판 후 `^2.0.0`.

---

## 6. 테스트 환경 설계 (레포 내장, git 커밋)

### 6.1 디렉토리 구조

```
next-redis-cache/
├─ package.json              # 배포 패키지. files:["dist"], workspaces 없음
├─ tsconfig.json             # 에디터·typecheck(전체) / tsconfig.build.json(src만) / tests는 tsconfig.json이 포함
├─ tsup.config.ts  eslint.config.mjs  vitest.config.ts  playwright.config.ts(P0c)
├─ stryker.config.mjs  vitest.mutation.config.ts(P0e)  .size-limit.json  .gitattributes  .nvmrc  LICENSE  ROADMAP.md
├─ src/
├─ tests/
│  ├─ support/               # redis 팩토리, 네임스페이스·DB 할당, waitFor, toxiproxy 클라이언트, mini-redis,
│  │                         # handlers(핸들러 직접 구동), repro(재현 규약), quarantine(P0d~)
│  ├─ unit/  property/  integration/  fault/
│  ├─ contract/{types,oracle}/
│  ├─ e2e/{static-site,full-legacy,full-cc}/ + fixtures.ts
│  ├─ chaos/ (harness.ts + 시나리오)  perf/baseline/
│  └─ fixtures/next-build/   # 7-4 프리워밍 재현용 Next 16.3.6 빌드 산출물 일부
├─ test-apps/
│  ├─ static-site/  full-legacy/  full-cc/  _shared/
│  └─ _variants/{next-16.1,next-16.3,canary}/   # 버전별 package.json(+lock)
├─ scripts/                  # 전부 Node .mjs
│  ├─ check-pack.mjs  check-no-hangul.mjs  quality.mjs  coverage-summary.mjs  (P0a)
│  ├─ infra.mjs  test-all.mjs  (P0b)
│  ├─ lib/{run,pack-rules,hangul-rules,work}.mjs
│  ├─ pack.mjs  prepare-app.mjs  origin-server.mjs  fleet.mjs  contract-types.mjs   (P0c)
│  ├─ perf.mjs   (P0d)
│  └─ check-quarantine.mjs  junit-summary.mjs  mutation-summary.mjs  nightly-issue.mjs   (P0e)
├─ docker/
│  ├─ compose.yml            # 프로필: redis84, redis72, prodlike, toxiproxy, replica
│  ├─ redis/prodlike.conf
│  └─ toxiproxy/proxies.json
└─ .github/workflows/{ci.yml, chaos.yml(재사용), nightly.yml, release.yml}
```

- 계획 대비: `ci-matrix.mjs`는 만들지 않았다 — 매트릭스는 `fromJSON(inputs.level == 'full' && ... || ...)` 식으로 ci.yml 안에서 계산한다. `tests/perf/scenarios/`는 시나리오가 2개뿐이라 `scripts/perf.mjs` 안에 둔다.

- npm workspaces 미사용(앱별 Next 버전 충돌, 심링크 문제). 테스트 앱은 독립 npm 프로젝트, 루트 스크립트가 조립.
- 게시물 격리: `files:["dist"]` + `check-pack.mjs`가 `npm pack --dry-run --json` 목록을 `dist/**`, `README.md`, `LICENSE`, `package.json` 화이트리스트와 대조(PR 게이트). exports·main·module·types가 가리키는 파일 누락도 실패.
- **코드는 영어만(2026-09-29 사용자 결정)**: `.md`를 제외한 모든 파일(src·tests·test-apps·scripts·docker·workflow·설정)에 한글(U+1100–U+11FF, U+3130–U+318F, U+AC00–U+D7AF)이 있으면 `check-no-hangul.mjs`가 실패한다. 주석·JSDoc·문자열·테스트 이름 모두 해당. 마크다운 문서(ROADMAP·README·CHANGELOG)와 커밋 메시지는 한국어 유지. `quality`와 CI static job에 연결. 추적 파일 + 무시되지 않은 미추적 파일을 검사해 커밋 전에도 잡는다.

### 6.2 테스트 앱의 패키지 소비

- **`npm pack` tarball 설치**(심링크 금지): 실제 소비자와 동일(exports·files·ESM/CJS), peer `next`/`@redis/client`가 앱 쪽으로 해석되어 Next 단일 인스턴스, standalone 트레이싱 정상.
- lock 충돌 회피: 변형 `package.json`에는 패키지를 넣지 않고 `npm ci` 후 `npm i --no-save <tgz>`. 설치 뒤 `npm ls next @redis/client`로 단일 버전 확인.
- 로컬 빠른 반복 `--hot-dist`: 새 `dist`를 `.work/<app>/node_modules/.../dist`에 **복사**(CI는 항상 tarball).
- 기준선 모드 `--pkg npm:1.0.6`: 같은 시나리오를 게시본으로 실행(P0d 재현·기준선).
- Next 매트릭스: `_variants/next-16.1`·`next-16.3`에 lock 커밋, 앱 소스는 공유하고 `prepare-app`이 `.work/<app>@<variant>/`로 **복사** 조립(Windows 심링크 권한 회피). canary는 lock 없이 nightly·실패 허용. Dependabot이 변형 lock 갱신.
- **P0c 구현 세부(확정)**
  - 변형 고정값(2026-09-29 최신 패치): `next-16.1` = next 16.1.7 + react/react-dom 19.2.8, `next-16.3` = next 16.3.6 + react 19.3.0, 공통 `@redis/client` 5.12.1. canary = `next@canary` + `react@latest`, lock 없음.
  - `pack.mjs`: 작업 트리 → `.artifacts/nrc-local.tgz`(`--no-build`면 기존 dist), `npm:<버전>` → `.artifacts/nrc-npm-<버전>.tgz`(한 번 받으면 재사용).
  - `prepare-app.mjs <app|all> --variant --pkg local|npm:1.0.6|x.tgz --build A[,B] --api v1 --hot-dist --no-pack`: 변형 lock 해시가 같으면 `npm ci` 생략, tarball 해시가 같으면 재설치 생략, tarball은 상대경로로 `npm install --no-save`. `npm ls next @redis/client --all`로 각 1버전만 있는지 검사(없거나 2개 이상이면 실패). 빌드는 `.next/standalone`을 `builds/<id>/`로 옮기고 `.next/static`·`public`·`_shared`를 복사, `nrc-build.json`(app·variant·buildId·api·next·패키지 버전) 기록.
  - 빌드는 `next build`를 **비동기 spawn**한다 — origin server가 같은 프로세스에 있어 `spawnSync`면 빌드 중 fetch가 멈춘다(실제로 use-cache 채움 타임아웃으로 빌드가 실패했다).
  - next.config는 `outputFileTracingRoot`·`turbopack.root`를 앱 디렉토리로 고정한다(레포 루트의 package-lock.json을 워크스페이스 루트로 오인하지 않게). standalone의 `cacheHandler` 경로는 Next가 distDir 기준 상대경로로 기록하므로 `builds/<id>/`로 옮겨도 동작한다.
  - Windows: 빌드 직후 새 파일(static-site 약 3,300개)을 처음 열 때 Defender 검사로 193초가 걸려 첫 기동이 fleet 준비 타임아웃(120초)을 넘겼다. `prepare-app`이 빌드 직후 모든 파일을 한 번 읽어 그 비용을 흡수한다(`.work/`를 Defender 예외로 두면 즉시). Linux CI는 해당 없음.

### 6.3 테스트 앱

공통: `output:"standalone"`, `generateBuildId=BUILD_ID`, `cacheMaxMemorySize:0`, `cacheHandler`+`cacheHandlers.default/remote` = `_shared` 핸들러, `NRC_API=v1|v2` 어댑터, `TEST_NS`·`REDIS_URL` 환경변수, `node .next/standalone/server.js`로 기동.

관측성(`TEST_HOOKS=1`에서만): 모든 응답에 `data-build`·`data-render-id`(UUID)·`data-rendered-at`·`data-instance`, `/api/__test/stats`(onEvent 카운터), `/api/__test/unhandled`(unhandledRejection 수). **origin server**: `GET /data/:key?delay=ms`(버전 반환·호출 카운트), `POST /data/:key`(버전 증가), `GET /hits`.

- **static-site**(docs 패턴): `/docs/[...slug]` 약 120개 `dynamicParams=false`, 중첩 layout·route group, seed 기반 200~500KB 본문 / `/`·`/about`·`not-found` / `/api/og/docs/[...slug]` force-static PNG 약 50개 / `icon.tsx` / `instrumentation.ts`.
- **full-legacy**(cacheComponents off): `/isr/[id]` revalidate=2, `/pinned/[id]` dynamicParams=false+태그 fetch, `/fetch-tags`, 라우트 핸들러(force-static, revalidate=5), 서버 액션(`revalidateTag` 무/‘max’/{expire}, `revalidatePath`), `/race/[k]`(origin 지연 중 무효화).
- **full-cc**(cacheComponents on): `"use cache"`+`cacheTag`+`cacheLife('hours')`, 커스텀 `short`{revalidate:2,expire:10}, `"use cache: remote"`, PPR 페이지(`postponed` 보존), `updateTag` 액션, 세그먼트 prefetch 대상.
- 앱을 나누는 이유: Next 16에서 cacheComponents와 `export const revalidate/dynamic` 동시 사용 불가로 알고 있음 — **P0c 첫 빌드에서 확인**.
- **P0c 확인 결과·구현 세부(확정)**
  - **cacheComponents 제약 확인**: full-cc(16.3.6) 페이지에 `export const revalidate = 60` → `Route segment config "revalidate" is not compatible with nextConfig.cacheComponents. Please remove it.`, `export const dynamic = "force-dynamic"` → 같은 오류(`"dynamic"`)로 빌드 실패. 앱 분리 유지.
  - 앱은 **JS(.jsx/.mjs)** 로 작성했다(계획은 TS). 변형에 typescript를 넣지 않아 설치·빌드가 가볍고, 타입 검증은 contract-types가 맡는다.
  - 테스트 훅 경로는 `/api/nrc-test/stats`·`/api/nrc-test/unhandled`다 — `__test`처럼 `_`로 시작하는 폴더는 App Router의 private folder라 라우트가 되지 않는다.
  - `NRC_API=v1` 어댑터(`_shared/cache-handler.mjs`·`use-cache-handler.mjs`)는 **README Quick Start 배선을 그대로** 쓴다(onCreation 안에서 `await client.connect()`, use-cache는 top-level await). 재현 테스트가 실제 사용자가 겪는 것을 보려면 문서 배선이어야 한다. 카운터는 서브클래스·래퍼로만 붙인다. `NRC_API=v2`는 P2에서 채운다(지금은 명시적 오류).
  - instrumentation 플래그: `NRC_PREWARM=1`(README Step 4의 `registerInitialCache`, await), `NRC_CLEANUP=1`(`cleanupOldBuildKeys` keepPrefix=자기 빌드, await). e2e 기본값은 static-site·full-legacy에 prewarm on — 1.0.6은 빈 Redis에서 `dynamicParams=false` 페이지가 404라서다(이 자체가 A2 재현).
  - 마커: TEST_HOOKS=1일 때 `<div id="nrc-test" data-build data-render-id data-rendered-at data-instance>`. full-cc는 cacheComponents에서 `Date.now()`·`randomUUID()`를 캐시 스코프 밖에서 못 쓰므로 마커를 `"use cache"` 컴포넌트 안에 넣는다(= 캐시 항목 생성 시점).
  - static-site 본문은 페이지당 텍스트 100~250KB(HTML은 RSC 인라인 때문에 약 2배 → 200~500KB). 처음엔 텍스트 200~500KB로 만들었더니 HTML이 최대 1MB, 1벌이 Redis 약 200MB라 로컬 반복이 무거웠다.
  - full-cc: 수명이 짧은 캐시(`short`, expire 10s < 5분)와 `"use cache: remote"`는 정적 셸에서 빠지므로 `<Suspense>` 안에 둔다. PPR 셸의 캐시 컴포넌트는 origin fetch를 하지 않는다(동적 구멍에서 프리렌더가 중단될 때 진행 중 fetch가 "Filling a cache during prerender timed out"으로 보고됨). `/dyn/[id]`(요청마다 use-cache 조회)는 chaos·perf용으로 추가.
  - full-legacy `/pinned/[id]`는 테스트 간 격리를 위해 id 1~6.
  - 서버 액션은 브라우저 없이 JS 없는 폼 제출(숨은 `$ACTION_ID_*` 필드를 multipart로 POST)로 호출한다 → e2e에 Playwright 브라우저가 필요 없다(CI에서 chromium 설치 생략).

### 6.4 인프라

- **docker compose**(`docker/compose.yml`, 호스트 포트 env로 덮어쓰기 가능)
  - `redis84`(기본, `redis:8.4`, `requirepass test`), `redis72`(HEXPIRE 없는 하한)
  - `prodlike`: 운영(`helm-chart/mirunamu/redis/values.yaml`) 흉내 — AOF everysec + RDB save, `volatile-lru`, `requirepass`, maxmemory는 compose 명령 인자로 16mb/384mb 전환
  - `toxiproxy`: `redis84`·`prodlike` 앞단 프록시, 제어 API 8474를 테스트가 HTTP로 직접 호출(latency/jitter, timeout, reset_peer, bandwidth, limit_data)
  - `replica`(선택): 복제 구성만 흉내(failover 비목표)
  - 기본 bridge + 포트 매핑(`network_mode: host` 금지 — Windows 미지원)
- **역할 분담**: testcontainers = integration(파일 단위 자립, 무작위 포트, 버전 파라미터화) / compose = e2e·chaos·perf·fault(toxiproxy)·수동 디버깅.
- **P0b 구현 세부(확정)**
  - compose 프로젝트명 `nrc`. 호스트 포트 기본값: redis84 `6384`, redis72 `6372`, prodlike `6390`, replica `6391`, toxiproxy API `8474`, 정적 프록시 `26384`(→redis84)·`26390`(→prodlike). 각각 `NRC_*_PORT` env로 덮어쓰기.
  - `infra:up` 기본 프로필 = redis84·redis72·toxiproxy. `npm run infra:up -- prodlike`처럼 인자로 지정, `all`은 전부. prodlike는 `prodlike`·`replica` 두 프로필에 속한다(replica의 primary). `infra:down`은 모든 프로필 + 볼륨 삭제.
  - toxiproxy 격리: vitest 워커마다 전용 프록시 `nrc_w<poolId>`를 `26399+poolId` 포트에 만든다(26400–26415 매핑 → **워커 최대 16개**). 한 워커 안의 테스트 파일은 순차라 프록시를 동시에 공유하지 않는다. 전역 `/reset`은 병렬 테스트에서 쓰지 않는다.
  - Redis 버전 선택: `NRC_REDIS_VERSIONS`(쉼표 목록, 기본 `8.4,7.2`). CI는 셀마다 하나.
  - testcontainers는 `~12.0.4` 고정 — 12.1+는 `engines.node >=22.22`라 로컬 Node 22.21에서 경고. 로컬 Node를 22.22+로 올리면 해제 가능.
  - mini-redis TS 포팅은 원본 대비 값 바이너리 안전(Buffer 저장), `AUTH`(password 옵션)·`PTTL`·`SET PX`·`DBSIZE`·`HGETALL`·`FLUSHDB` 추가, `connectionCount()`·`getBuffer()` 추가.
- **멀티 인스턴스·롤링**(`scripts/fleet.mjs`, P0c): BUILD_ID A/B 산출물 2벌, 인스턴스 2~3개(get-port, `INSTANCE_ID`, toxiproxy 경유 공유 Redis), 내장 라운드로빈 LB, 롤링 A→B(`maxSurge 1, maxUnavailable 0` 재현)와 롤백 B→A, 종료는 tree-kill.
  - 구현(계획 대비): get-port·tree-kill 의존성 없이 포트는 `listen(0)`으로 받고, `node server.js`를 셸 없이 직접 spawn하므로 자식 프로세스만 종료하면 된다(SIGTERM 5초 후 SIGKILL). 준비 판정은 `/api/nrc-test/stats` 200(기본 120초). LB는 응답에 `x-nrc-upstream`을 붙인다. 스스로 종료한 인스턴스는 `fleet.crashed`(I2). `stop()`은 네임스페이스 키를 SCAN+UNLINK로 지운다(`NRC_KEEP_KEYS=1`이면 남김) — 안 지우면 e2e 몇 번에 로컬 Redis가 1.5GB까지 찼다. 인스턴스 로그는 `.work/logs/<app>@<variant>/<ns>/<id>.log`.
- **Windows**: 스크립트 전부 Node, `.gitattributes` eol=lf, 짧은 `.work` 경로, testcontainers는 Docker Desktop npipe. **GitHub windows 러너는 Linux 컨테이너 불가** → Windows CI는 docker 불필요 계층만.

### 6.5 테스트 계층

| 계층 | 도구 | 목적 | 예산 | 트리거 |
|---|---|---|---|---|
| unit | vitest `unit`, 가짜 시계 | 키·엔벨로프·TTL·태그 판정·circuit·로거 | <30s | PR(Node 22/24, Windows) |
| property | fast-check | 엔벨로프 왕복, TTL 단조·상한, 태그 판정 ≡ Next 참조 구현 | <30s | PR |
| integration | testcontainers Redis 7.2/8.4 | 명령 의미, NX, TTL(`PTTL` 범위), 축출, 정리, 1만 키 배치 | <3m | PR |
| fault | mini-redis + toxiproxy | 연결 전·끊김·재연결·무응답·지연·reset_peer, unhandledRejection 0, offline queue 폭주 0 | <3m | PR(mini-redis 부분은 Windows 포함). vitest project `fault`(mini-redis, 도커 불필요) + `fault-docker`(파일명 `*.docker.test.ts`, compose toxiproxy 필요) |
| contract-types | tsc 버전별 | `satisfies next/.../cache-handlers/types#CacheHandler` | <1m/버전 | PR(16.1/16.3), nightly(canary) |
| contract-oracle | vitest + fast-check | 연산 시퀀스를 Next `createDefaultCacheHandler`와 우리 핸들러(`swr:false`)에 적용해 결과 차분 | <1m | PR |
| e2e | Playwright + fleet 2인스턴스 | HTML·RSC·세그먼트 prefetch, SWR, 인스턴스 간 전파, 404 0, sitemap 200 | <8m/셀 | PR 16.3×8.4×3앱 / nightly 전체 |
| chaos | vitest 장시간 + fleet + toxiproxy | C1~C14, 불변식 I1~I5 | <15m | nightly, 릴리스 전 |
| perf | autocannon | 히트 p50/p99, 요청당 Redis 왕복 수, 빌드 1벌 메모리 | <10m | nightly(결정론 지표는 PR) |
| mutation | Stryker(vitest runner) | 코어 모듈 테스트 품질 | <60m | weekly |

**chaos**: C1 기동 시 Redis 부재, C2 트래픽 중 kill, C3 무응답, C4 지연 300ms+jitter, C5 reset_peer, C6 FLUSHALL, C7 축출 압박(16mb), C8 AOF 재시작(태그 상태 롤백), C9 잘못된 비밀번호, C10 WRONGTYPE, C11 롤링 A→B, C12 롤백 B→A, C13 느린 렌더 중 무효화, C14 클럭 스큐(`TEST_CLOCK_OFFSET_MS`).

**불변식**: I1 prerender 경로 404/5xx 0 · I2 비정상 종료·unhandledRejection 0 · I3 지연 상한 · I4 복구 후 10s 내 히트 재개 · I5 Redis 정상 시 무효화 이후 옛 데이터 fresh 응답 0.

**perf 게이트**: 결정론 지표(요청당 왕복 수 = `INFO commandstats` 차분, 레거시 히트 ≤2·use-cache 히트 ≤2 / 빌드 1벌 `MEMORY USAGE` 합 기준선 +5% 이내)는 PR 하드 게이트. 시간 지표(p50/p99)는 nightly 3회 중앙값, 기준선 +20% 초과 시 경고만.

**P0c~P0d 구현 세부(확정)**

- **재현(기대 실패) 규약** — 재현 테스트는 *올바른 동작*을 단언하고 기대 실패로 등록한다. 수정되면 테스트가 통과 → 러너가 "기대 실패인데 통과"로 실패 → 수정 커밋이 표식을 지워야만 green.
  - vitest: `itRepro("7-x", "...", fn)`(`tests/support/repro.ts`, 내부는 `it.fails`) → 수정 시 `it("[7-x] ...")`로 교체.
  - Playwright: 테스트 첫 줄 `repro("7-x", "원인")`(`test.fail`) → 수정 시 삭제.
  - tsc(contract-types): `// @ts-expect-error [7-x] ...` → 수정 시 "Unused @ts-expect-error"로 실패하므로 삭제.
  - `NRC_REPRO=show`면 셋 다 일반 테스트로 돌아 실제 실패 메시지를 출력한다(재현 증거). 남은 재현은 `grep -rn "\[7-" tests`로 본다.
  - 제목에 ID를 넣는다: `[7-x]`(2절 문제) 또는 `[A2]`(수용 기준 — 버그 번호가 없는 것).
- **contract-types**: `scripts/contract-types.mjs --variant next-16.1|next-16.3|canary|all --pkg`가 `.work/contract@<variant>/`에 변형 의존성+tarball을 설치하고 `tests/contract/types/*.contract.mts`(NodeNext, ESM 소비자 관점)를 레포의 tsc로 컴파일한다. 루트 typecheck에서는 제외.
- **contract-oracle**: `tests/contract/oracle/use-cache.oracle.test.ts`. fast-check 프로그램(set/get/updateTags/시간 경과)을 Next `createDefaultCacheHandler`와 우리 핸들러(mini-redis)에 적용하고, Next use-cache wrapper가 get 결과로 내릴 판정(`miss`/`hit`/`stale`, `getExpiration` 결과 ≥ timestamp면 폐기)을 비교한다. 시간은 `Date.now`·`performance.now`를 가상 시계로 바꿔 두 핸들러와 mini-redis 만료가 같은 시계를 본다. 비교 대상은 루트 devDependency의 Next(현재 16.1.6). docker 불필요라 `npm test`에 포함(vitest project `contract`).
- **chaos 구현 범위(P0d)**: 6.9 매핑의 C1·C9·C2·C5·C6·C13·C11·C12(`tests/chaos/*.test.ts`, vitest project `chaos`, 파일 순차). 전제: `infra:up -- redis84 toxiproxy`, static-site A·B / full-legacy A / full-cc A 빌드. C3·C4·C7·C8·C10·C14는 해당 기능 단계(P3·P4·P6)에서 추가.
- **perf 지표 정의(계획 대비)**: "왕복 수" 대신 **요청당 Redis 명령 수**를 잰다. `INFO commandstats`는 서버 전역이라 다른 트래픽이 섞이므로, 별도 연결의 `MONITOR`로 이번 네임스페이스 키를 건드린 명령만 센다. 키 모양으로 핸들러를 가른다(`uc:` = use-cache, `_tags`·`_tagTtls`·`_revalidated` = 태그 상태, 나머지 = 레거시). use-cache 시나리오는 `/dyn/1`(PPR 셸은 레거시, 동적 부분이 use-cache)이라 두 핸들러 합계다. 게이트: 명령 수는 기준선 초과 금지, 메모리는 같은 Redis 마이너일 때 +5% 이내. 시간 지표는 `--time`(autocannon 10초, 8연결).

### 6.6 품질 게이트와 결정론

- 커버리지(v8, unit+property+integration+fault 병합, `src/**`): lines 90 / branches 85 / functions 90, 파일별 lines ≥80 — **2.0.0 전까지 리포트만, 2.0.0부터 차단**.
- `tsc --noEmit`(strict) + contract-types, `publint`, `attw --profile node16`(조건별 types 오류 0), `check-pack` 화이트리스트, `check-no-hangul`, size 예산(엔트리별 ESM gzip, 초기 측정치 +20%), eslint 0 오류, mutation ≥70%(2.0.0부터 차단).
  - P0a 실제값: attw는 P1(조건별 types 교정) 전까지 `false-esm` 규칙만 무시. size-limit은 `@size-limit/file`로 엔트리 파일+공유 청크의 gzip 크기를 잰다(dist가 minify되지 않으므로 "min+gz"가 아니라 배포물 그대로의 gz). 1.0.6 기준 `.` 4.12kB→예산 5kB, `./use-cache` 3.14kB→3.8kB, `./instrumentation` 1.69kB→2.1kB, CJS 합계 7.5kB→9kB. 별도 `size.mjs` 없이 `.size-limit.json`만 둔다.
  - 커버리지는 P0a/P0b 시점 CI에서 unit+property만 수집. integration·fault 병합은 P0e(리포팅)에서.
- flaky: 재시도 금지(`retry:0`, Playwright `retries:0`). 불안정 테스트는 `@quarantine` 태그로 게이트 제외 + 추적 이슈 + 7일 내 수정/삭제, nightly `--repeat-each=20`.
  - 구현(P0e): vitest는 `itQuarantine("#<이슈> until YYYY-MM-DD", name, fn)`(`tests/support/quarantine.ts`) — 평소 skip, `NRC_QUARANTINE=only`면 그것만 `repeats: 20`. Playwright는 제목에 `@quarantine(#<이슈> until YYYY-MM-DD)`, config가 평소 `grepInvert`, `NRC_QUARANTINE=only`면 `grep`. `scripts/check-quarantine.mjs`(CI static)가 이슈 번호·기한 형식, 기한 경과, 7일 초과를 실패시킨다(음성 시험: 지난 기한·형식 위반 주입 시 exit 1 확인). nightly `quarantine` job이 x20 반복.
- 리포팅: vitest JUnit·JSON·coverage(lcov/html), Playwright html+trace+JUnit, perf JSON → artifact, 요약은 `$GITHUB_STEP_SUMMARY`. 외부 서비스 없음.
  - 구현(P0e): `scripts/junit-summary.mjs`가 JUnit(vitest `reports/junit.xml`, Playwright `reports/e2e-junit.xml`)을 표로 요약. 커버리지는 unit(Node 22)·integration(7.2/8.4)·fault job이 `NRC_BLOB=<이름>`으로 blob 리포트(커버리지 포함)를 남기고, ci `coverage` job이 `vitest --merge-reports`로 합쳐 `coverage-summary.mjs`로 요약(리포트 전용, gate 밖). perf는 `reports/perf.json`+요약, mutation은 `scripts/mutation-summary.mjs`.
  - mutation(계획 대비): `@stryker-mutator/vitest-runner` 10.0.0은 vitest 5와 dry run은 되지만 변이마다 실행 테스트 0건으로 보고해 전부 "survived"가 된다. **command runner**로 docker 불필요 계층(`vitest.mutation.config.ts`: unit·property·contract·fault/mini-redis)을 변이마다 통째로 돌린다(`--bail 1`). 671개 변이, 로컬 약 15분(동시성 4).
- 결정론: 패키지 시간 읽기는 내부 `clock.now()`로 모음(unit/property는 가짜 시계). 실제 시간이 필요한 곳은 sleep 대신 마감 있는 `waitFor` 폴링, TTL은 `PTTL` 범위 단언. 테스트마다 고유 네임스페이스 `t_<pid>_<seq>`, 전역 스캔 테스트는 워커별 논리 DB(`VITEST_POOL_ID % 16`) + 해당 DB만 FLUSHDB. 포트는 동적. 콘텐츠는 seed 생성기.

### 6.7 로컬 DX

사전 요구: Node 22 LTS(`.nvmrc`), npm 10+, Docker Desktop(WSL2, compose v2), 여유 메모리 8GB, `npx playwright install chromium`(P0c~).

| 스크립트 | 내용 |
|---|---|
| `test` | unit + property + contract-oracle (docker 불필요; oracle은 P0c~) |
| `test:unit` / `test:prop` / `test:int` / `test:fault` / `test:contract` | 계층별. `test:fault` = fault + fault-docker, `test:fault:nodocker` = mini-redis 부분만 |
| `check-no-hangul` / `check-pack` | 개별 게이트 |
| `test:e2e` / `test:chaos` / `test:perf` / `test:mutation` | Playwright(빌드 필요) / vitest chaos(빌드+infra 필요) / `perf.mjs --check` / Stryker |
| `test:contract` = `test:contract:oracle`(vitest contract) + `test:contract:types`(`contract-types.mjs --variant all`) | P0c~P0d |
| `test:all` | infra:up → 전 계층 → infra:down |
| `infra:up` / `infra:down` / `infra:logs` / `infra:ps` / `infra:cli` | compose 관리 |
| `pack:local` / `apps:prepare` / `fleet` / `origin` | tarball 생성 / 앱 조립·빌드 / 수동 fleet(기본 LB 3000, origin 4010) / origin 단독 |

로컬 e2e 한 바퀴: `npm run infra:up -- redis84 toxiproxy` → `node scripts/prepare-app.mjs all --build A`(패키지 1.0.6 기준선이면 `--pkg npm:1.0.6`) → `npm run test:e2e`. chaos는 여기에 `node scripts/prepare-app.mjs static-site --build A,B` 후 `npm run test:chaos`.
| `quality` | publint + attw + size-limit + check-pack + check-no-hangul (전부 실행 후 하나라도 실패면 실패) |

### 6.8 CI

`ci.yml`(pull_request, push, workflow_call `level: pr|full`):

```
setup(매트릭스 계산, pack → tgz artifact)          [P0c~]
 ├─ static: check-no-hangul · lint · typecheck · build · quality
 ├─ unit: Node [22,24]   (Node 20은 2026-04-30 EOL이고 vitest 5·size-limit 14가 ^22.12 요구 → 제외)
 ├─ unit-windows: windows-latest Node 22 (docker 불필요 계층: unit·property·fault(mini-redis)·check-pack)
 ├─ integration: Node 22 × Redis [7.2, 8.4]          [P0b~]
 ├─ fault: Node 22 (infra:up redis84+toxiproxy → mini-redis + toxiproxy → infra:down)   [P0b~]
 ├─ contract: Next [16.1, 16.3] (+full: canary)      [P0c~]
 ├─ e2e: pr = 16.3×8.4×3앱 / full = [16.1,16.3]×[7.2,8.4]×3앱 (+canary)   [P0c~]
 └─ gate: 필수 job 전부 성공 (브랜치 보호 required check는 이것 하나)
```

- `nightly.yml`(cron): ci full + chaos + perf + quarantine 반복 + Node 24 e2e, 실패 시 이슈 자동 생성. weekly: mutation + canary 전체.
- `release.yml`: `jobs.gate: uses: ./.github/workflows/ci.yml with level: full` + chaos 필수 부분집합(C1,C3,C7,C11) → `release`(needs 전부)가 changesets+OIDC 게시. 게이트 미통과 커밋은 게시 불가.
- 캐싱: setup-node npm 캐시(`package-lock.json`, `test-apps/_variants/*/package-lock.json`), Next 빌드 캐시(`.work/*/.next/cache`), Playwright 브라우저. Next 빌드는 `app×Next` 6벌만 하고 Redis 셀들이 artifact 재사용.
- 예산: PR ≤15분, full/nightly ≤60분, weekly mutation ≤90분.
- 보안: Action SHA 고정, 기본 `permissions: contents: read`, release job만 `id-token: write`·`contents`·`pull-requests: write`.
- **trusted publishing(OIDC) 전환**: ① (사용자, npmjs.com) 패키지 Settings → Trusted Publisher → GitHub Actions, owner `mirunamu00`, repo `next-redis-cache`, workflow `release.yml`(environment 선택) ② 워크플로 Node 24 또는 npm ≥11.5.1, `id-token: write`, `NODE_AUTH_TOKEN` 제거 ③ 1.1.0 실게시로 검증 ④ (사용자) "Require 2FA and disallow tokens", `NPM_TOKEN` 시크릿·토큰 폐기. 리스크(추측): changesets/action의 `.npmrc` 처리와 `setup-node registry-url`의 빈 토큰이 OIDC와 충돌하는지 — 첫 게시는 프리릴리스로 시험.
- 프리릴리스: `next` 브랜치에서 `changeset pre enter next` → `2.0.0-next.N`(dist-tag `next`), 안정화 전 `pre exit`.
- **P0c~P0e 구현(확정, 계획 대비 차이 포함)**
  - 트리거: `push`에 `feat/**` 추가(PR 없이 기능 브랜치 검증, gh CLI 없음). `pull_request`·`master`·`next`는 그대로.
  - ci.yml job: static(+check-quarantine) · unit[22,24] · unit-windows · integration[7.2,8.4] · fault · setup(build+pack → `package-tarball` artifact) · contract[16.1,16.3(+canary, full, continue-on-error)] · e2e[app × 16.3 × 8.4 / full: app × [16.1,16.3] × [7.2,8.4]] · perf(결정론 게이트, full이면 `--time`) · coverage(병합, gate 밖) · gate.
  - e2e 셀마다 자기 앱을 빌드한다(계획은 `app×Next` 6벌 빌드 후 Redis 셀이 artifact 재사용). 빌드가 30~40초라 수백 MB standalone(static-site 145MB)을 artifact로 옮기는 것보다 싸다.
  - Playwright 브라우저 설치 없음(서버 액션도 폼 제출로 검증). 브라우저가 필요한 테스트가 생기면 그 job에 `npx playwright install --with-deps chromium` 추가.
  - `chaos.yml`: 재사용 워크플로(`workflow_call`·`workflow_dispatch`, 입력 `files`·`variant`). 앱 빌드(static-site A·B, full-legacy A, full-cc A) 후 `vitest --project chaos`.
  - `nightly.yml`: 매일 03:17 KST — ci level=full + chaos 전체 + quarantine x20 + e2e Node 24(3앱). 매주 월 04:41 KST — + mutation + canary e2e(단일 job, 테스트 단계 `continue-on-error` 후 outcome을 report가 읽음). schedule 실행 실패(또는 canary 실패) 시 `scripts/nightly-issue.mjs`가 `nightly-failure` 라벨 이슈를 열거나 댓글을 단다. **schedule은 기본 브랜치에서만 돌므로**, `feat/**`에 nightly.yml·chaos.yml을 바꾸는 push가 있으면 주간 job까지 전부 1회 돈다(이슈는 안 연다).
  - `release.yml`: `gate`(ci.yml level=full) + `chaos`(필수 부분집합: `startup.test.ts` C1·C9, `rolling.test.ts` C11·C12) → `release`가 `needs: [gate, chaos]`. 계획의 C3(무응답)·C7(축출)은 해당 시나리오가 생기는 단계(P3·P6)에서 부분집합에 추가. 게시 방식(NPM_TOKEN, 태그 참조 액션, Node 20)은 P1에서 OIDC·SHA 고정·Node 24로 바꾼다.
  - 워크플로 정적 검사: `docker run --rm -v <repo>:/repo -w /repo rhysd/actionlint`(로컬, 설치 불필요). 기존 gate의 `node -e` 따옴표 info 1건 외 지적 없음.

### 6.9 회귀 매핑 (1.0.6에서 먼저 실패)

| ID | 계층 | 앱·도구 | 시나리오 |
|---|---|---|---|
| 7-1 | integration + oracle + e2e | full-cc, full-legacy | `updateTags([t],{expire:31536000})` 후 set→get 히트 기대 / oracle 불일치 / 액션 `revalidateTag(t,'max')` 후 3번째 요청 히트·origin +1 (A7), 레거시 `/pinned` 동일 |
| 7-2 | fault + chaos C1·C9 | static-site | 닫힌 포트·connect 대기에서 `get()` 1.5s 내 null, hook throw 시 reject 없음 / Redis 없이 fleet 기동 2s 내 sitemap 200 (A2) |
| 7-3 | fault(mini-redis) + chaos C2·C5 | full-cc | `reconnectStrategy:false` 끊긴 뒤 get 100회 → unhandled 0 / 재연결 중 100회 → 복구 후 밀린 GET 0 (A4) |
| 7-4 | integration + e2e | static-site | prewarm 후 `segmentData` 키 = meta `segmentPaths`, `/index`·og APP_ROUTE 키 존재, not-found status 보존 / 세그먼트 prefetch 200 (A6) |
| 7-5 | integration + perf | static-site | `EX 1` 1000개 → 2s 후 DBSIZE 기준선 / 배포 10회 키 상한 (A5) |
| 7-6 | e2e + chaos C6·C13 | full-legacy `/pinned`·`/race` | revalidatePath 직후 200+옛 본문→새 본문, FLUSHALL 후 200, 렌더 중 무효화에도 옛 데이터 부활 없음 (I5) |
| 7-7 | unit + fault | — | set 중 hang → `logger.warn` 1회, 연속 실패는 전이 시에만 |
| 7-8 | contract-types | — | peer 범위 + 16.x 계약만 검증(Next 15 제외 확정) |
| 7-9 | integration + chaos C11·C12 | static-site A/B | 1만 키 UNLINK 배치 ≤500, 롤링 중 최근 접근 옛 빌드 보류+TTL 상한, 연결 전이면 ready 뒤 실행, docs `build-keys.test.mjs` 포팅 |
| 7-10 | unit | — | 명령 성공 후 `vi.getTimerCount()===0` |
| 7-11 | unit + integration | full-legacy 라우트 핸들러 | APP_ROUTE revalidate=5 → PTTL≈7.5s, 정적 → staticSeconds, 오래된 lastModified 재시드 즉시 만료 없음 |
| 7-12 | integration + property | — | NX set 시 기존 메타 불변, 같은 키 set 중첩 시 get이 두 번째 대기 |
| 7-13 | static | — | README 코드 블록 추출 → contract-types 컴파일 |

docs에서 이관된 검증: `prod-cache.spec.ts`(Redis 없이 200) → static-site e2e+C1 / `resilient-cache-handler.test.mjs` → fault+C3·C6 / `redis-connect.test.mjs` → fault / `build-keys.test.mjs` → integration+C11·C12 / `no-redis.test.mjs` → unit+static-site e2e.

**P0d 재현 현황(1.0.6, 전부 기대 실패로 등록)** — 증거는 `NRC_REPRO=show`로 돌린 실제 실패 메시지.

| ID | 재현 테스트(파일) | 1.0.6 실패 내용 |
|---|---|---|
| 7-1 | integration `repro.test.ts` 3건, oracle(durations), e2e full-cc·full-legacy 각 1건 | `updateTags(t,{expire:1y})` 뒤 쓴 항목 get → `undefined`, `getExpiration` = now+1년, 레거시 항목도 `null` / oracle 반례: 기준 `k0=hit:v1`, 우리 `k0=miss` / full-cc 'max' 후 origin 재호출 5회(기대 1) / 레거시 pinned 'max' 후 계속 404 |
| 7-2 | fault `repro-connection.test.ts` 3건, chaos C1 2건·C9 1건 | 닫힌 포트에서 get 1.5s 내 미결(`settled:false`), hook throw가 reject로 전파, `cleanupOldBuildKeys` 3s 내 미결 / prewarm on 인스턴스 10s 내 준비 안 됨, 첫 페이지 5s 타임아웃(Redis 부재·잘못된 비밀번호) |
| 7-3 | fault 2건, chaos C2 2건·C5 1건 | 닫힌 클라이언트에서 get 100회 → unhandledRejection 100건("The client is closed"), 재연결 중 get 100회 → 복구 후 GET 100건 재전송 / 트래픽 중 3초 장애 → unhandledRejection 171건(C2)·165건(C5), 복구 후 밀린 GET 3~22건 |
| 7-4 | integration 4건, e2e static-site 1건 | 세그먼트 키 `['_full','_tree','about/__PAGE__']`(기대 `/` 시작), `/index` 없음, `/icon`(APP_ROUTE) 없음, `/_not-found` 미프리워밍 / 프리워밍된 `/about` `/_tree` prefetch 404 |
| 7-5 | integration 2건 | 만료 후 `_tags` HLEN 50(기대 0), 깨진 필드 하나로 revalidateTag 전체 중단 → 항목 계속 서빙 |
| 7-6 | integration 2건, e2e full-legacy 1건, chaos C6·C13 | `revalidateTag(t,{expire})` 후 get `null`, 명시 태그 무효화 전 렌더 결과가 fresh로 부활 / revalidatePath 후 404만 관측 / 네임스페이스 삭제 후 docs 404 / 느린 렌더 중 무효화 뒤 `HIT` + 옛 버전 |
| 7-7 | fault 1건 | Redis hang 중 set 실패에 console.warn/error 0회 |
| 7-8 | unit 1건, contract-types `@ts-expect-error` 2건 | peer 최저 메이저 15, 레거시 클래스가 Next `CacheHandlerContext`로 생성 불가(자체 context 타입의 index signature) |
| 7-9 | integration 2건, chaos C11·C12 | 1만 키를 DEL 1회로 삭제(기대 ≥20회), 방금 읽힌 옛 빌드 키 삭제 / 롤링·롤백 중 옛 인스턴스 docs 404 |
| 7-10 | unit 1건 | 성공 후 타이머 1개 잔존 |
| 7-11 | unit 3건, integration 1건 | APP_ROUTE revalidate 5 → EX 47,304,000(1.5년), 정적 1.5년 > 30일, 이틀 전 lastModified 재시드 안 됨 / PTTL 47,304,000,000ms |
| 7-12 | integration 3건 | NX 스킵인데 태그 `['b']`로 덮어씀, 다른 Pod가 쓴 값을 고아로 삭제, 겹친 set에서 get이 `first` 반환 |
| 7-13 | unit 4건 | 기본 use-cache 키가 `uc:app:b1:…`(keyPrefix 밖), README `cacheLife("hours")` 주석 stale 3600(실제 300), Security 절 없음, "모든 Redis 호출 타임아웃" 주장 |
| A2 | e2e static-site 1건 | 빈 Redis(프리워밍 없음)에서 `dynamicParams=false` docs 404 |

1.0.6에서 통과하는(=버그가 아닌) 대조군도 같이 둔다: 즉시 만료 `updateTags(tags)`는 oracle과 일치(히트·미스 각 10건 이상 발생 확인), 레거시 핸들러는 ready 검사를 먼저 해 재연결 중 명령을 쌓지 않음, updateTag 서버 액션은 즉시 반영, C2·C5에서 I1(전부 200)·I4(10s 내 히트 재개)는 유지.

---

## 7. 로드맵

| 단계 | 작업 | 완료 기준 | 의존 | 규모 |
|---|---|---|---|---|
| **P0a 골격·CI** | 디렉토리, tsconfig 분리, vitest projects, eslint, `.gitattributes`, `.nvmrc`, LICENSE, `check-pack`, `quality`(publint/attw/size), `ci.yml`(static/unit/unit-windows/gate) | 로컬 typecheck·build·lint·test·quality 통과. 게시물 화이트리스트 게이트 동작. 기존 src 동작 불변 | — | S~M |
| **P0b 인프라** | compose(redis72/redis84/prodlike/toxiproxy/replica), testcontainers 헬퍼, mini-redis TS 포팅+자체 테스트, toxiproxy 클라이언트, `infra:*`, 네임스페이스·DB 격리, ci.yml integration/fault job | Windows Docker Desktop·Linux CI 양쪽 `infra:up` 성공, Redis 7.2/8.4 integration 스모크, toxic 4종을 테스트에서 제어 | P0a | M |
| **P0c 테스트 앱·하네스** | 앱 3개, `_variants` 16.1/16.3/canary, `pack`, `prepare-app`(tgz·`npm:1.0.6`·`--hot-dist`), origin server, fleet(LB·롤링), 테스트 훅, `NRC_API` v1/v2 어댑터, contract·e2e job | 각 앱이 16.1·16.3에서 standalone 빌드, **1.0.6(v1 API)** 으로 fleet 2인스턴스 동작, `npm ls` 단일 Next, cacheComponents 제약 확인 | P0b | L |
| **P0d 재현·기준선** | 6.9 매핑의 `it.fails`·e2e·chaos 실패 케이스, oracle 차분, perf 기준선(1.0.6 왕복 수·메모리) 커밋 | 전 항목 1.0.6에서 재현, 기준선 JSON 커밋, ci e2e(pr) 동작 | P0c | M |
| **P0e nightly·리포팅** | `nightly.yml`, release 게이트 연결, artifact 리포트, flaky 정책, Stryker | nightly 1회 완주, release가 게이트 없이 게시 불가 | P0d | S |
| P1 1.1.0 핫픽스 | 4절 목록 + LICENSE·exports types·Action SHA 고정·OIDC | 해당 `it.fails` 전환, static-site e2e 세그먼트 prefetch 200, OIDC+provenance 게시 | P0e | M |
| P2 v2 코어 | 팩토리 API, 키 스키마·엔벨로프, `_tagstate`, Next 16 의미론(레거시·use-cache SWR, `getExpiration=Infinity`), run 파이프라인(circuit·타임아웃), logger·onEvent, `connectRedis`, 빌드 페이즈 no-op, TTL 정책 → `2.0.0-next.0` | A1(7-1·2·3·5·6·7·10·11·12), A4, A7, A8 — oracle·fault·full-cc e2e로 판정 | P0 | L |
| P3 폴백·프리워밍 | FileSystemCache 폴백, 재시드, 새 프리워밍, Next 매트릭스 계약 → `next.1` | A2, A3, A6 (static-site e2e, C1·C3·C6), 16.1·16.3 통과 | P2 | M |
| P4 유지보수 | `cleanupOldBuilds`, `whenReady`, `startCacheMaintenance`, v1 레이아웃 호환, `_*` 예약, deprecated `cleanupOldBuildKeys` → `next.2` | A5 (C11·C12, integration) | P2 | S~M |
| P5 docs 통합 | docs 설정 전환, 래퍼·`tests/unit/*` 삭제, docs는 기존 `test:e2e:prod` 유지 + 롤아웃 후 운영 스모크(sitemap 200, 로그, Redis 키·메모리) | A10, 운영 24h 무사고, 롤백 리허설 1회 | P3·P4·P1 | S |
| P6 최적화 | 압축, `MEMORY USAGE` 측정, `tagStateCacheMs`, 파이프라이닝, HEXPIRE(≥7.4) 선택 → `next.3` | A9, 히트당 왕복 ≤2 | P2 | S~M |
| P7 2.0.0 | README 재작성, MIGRATION.md, pre exit, docs `^2.0.0`, 커버리지·mutation 게이트 차단 전환 | 전 수용 기준 충족, 안정판 게시 | P5·P6 | S |

클러스터 검증·롤백(P5): replicas 1이라 진짜 카나리 없음. ① 새 이미지를 로컬에서 `kubectl -n mirunamu port-forward svc/redis-master 6379`로 운영 Redis(8.4, 인증)에 붙이되 네임스페이스 `docs-canary`로 분리(비밀번호는 Secrets 레포에서 읽고 커밋 금지) ② 운영 배포 후 로그·Redis 메모리·키 수·sitemap 스모크 ③ 롤백은 helm-chart 자동 태그 커밋 revert → ArgoCD. 옛 빌드 키는 keepPrevious=1 + TTL 상한 1일로 남아 하루 내 롤백은 웜.

---

## 8. 확정된 결정 (2026-09-29 사용자 승인)

| # | 결정 |
|---|---|
| Q1 | 1.1.0 핫픽스를 먼저 내고 2.0으로 간다 |
| Q2 | Next 15 지원 제외, peer `next ^16.1` |
| Q3 | 디스크(빌드 산출물) 폴백 기본 on. Next 내부 경로 의존은 가드+매트릭스 계약 테스트 |
| Q4 | 태그 상태는 네임스페이스 전역 |
| Q5 | lazy 무효화만(역인덱스 폐지, eagerDelete 옵션 없음) |
| Q6 | 압축 기본 none으로 시작, P6 측정 후 재결정 |
| Q7 | 타임아웃 기본 read 1000ms / write 2000ms |
| Q8 | 지원 Redis 최소 6.2, HEXPIRE는 7.4+에서 선택 |
| Q9 | 프리워밍 패키지 기본 off, docs도 off — static-site perf로 수치 확인 후 최종 확인 |
| Q10 | `_tagstate` TTL 없음(태그 수로 한정, volatile-lru 비축출 = 의도) |
| Q11 | 프리릴리스는 `next` 브랜치 pre 모드, master는 1.x 핫픽스 게시 가능 유지 |
| Q12 | 메트릭은 `onEvent` 훅만 제공 |
| Q13 | 커버리지·mutation 게이트는 2.0.0부터 차단, 그 전엔 리포트 |
| Q14 | perf는 GitHub 호스티드 러너, 결정론 지표만 하드 게이트 |
| Q15 | canary는 nightly/weekly 실패 허용 + 이슈 알림 |
| Q16 | 외부 커버리지 서비스 없음(artifact + Step Summary) |
| Q17 | Windows CI는 docker 불필요 계층만. docker 계층은 로컬 Docker Desktop 수동 + Linux CI |
| Q18 | (2026-09-29 사용자) PR 없이 CI 검증: ci.yml `push.branches`에 `feat/**`. 기능 브랜치 push만 허용(master·next push, force-push, npm 게시 금지) |
| Q19 | (2026-09-29 사용자) Next 변형은 16.1.x·16.3.x 최신 패치 정확 고정 + 맞는 react. canary는 비고정·nightly 전용·실패 허용 |

### 8.1 실행 중 결정 (P0c~P0e, 사용자가 위임한 범위에서 에이전트가 결정)

| # | 결정 | 이유 |
|---|---|---|
| D1 | 테스트 앱은 JS(.jsx/.mjs) | 변형에 typescript 불필요, 빌드 가벼움. 타입은 contract-types가 검증 |
| D2 | 테스트 훅 경로 `/api/nrc-test/*` | `__test`는 App Router private folder |
| D3 | v1 어댑터 = README Quick Start 배선 그대로 | 재현 테스트가 실제 사용자 경험을 봐야 함 |
| D4 | 재현 규약: `itRepro`/`repro()`/`@ts-expect-error [7-x]` + `NRC_REPRO=show` | 수정 커밋이 표식을 지워야만 green, 증거 출력 가능 |
| D5 | perf 결정론 지표 = MONITOR로 센 요청당 명령 수 | `INFO commandstats`는 서버 전역이라 섞임 |
| D6 | mutation = Stryker command runner | vitest-runner 10.0.0 + vitest 5에서 변이별 테스트 0건 보고 |
| D7 | e2e 셀마다 앱 빌드, 브라우저 설치 없음 | 빌드 30~40초 < standalone artifact 이동, 서버 액션은 폼 제출로 검증 |
| D8 | nightly.yml·chaos.yml을 바꾸는 `feat/**` push에서 nightly 1회 실행(주간 job 포함) | schedule은 기본 브랜치에서만 돌아 머지 전 검증 수단이 없음 |
| D9 | release 필수 chaos 부분집합 = C1·C9·C11·C12(현재 구현분) | C3·C7은 해당 단계에서 추가 |
| D10 | static-site 본문 100~250KB 텍스트(HTML 200~500KB) | 1MB HTML은 로컬 반복이 과도 |

---

## 9. 리스크

- Next 내부 경로(`next/dist/server/lib/incremental-cache/file-system-cache.js`) 의존 — 매트릭스 계약 테스트로 조기 탐지.
- Next 16.x 마이너 변화(16.3의 음수 expire 표식 등) — canary 매트릭스.
- 클럭 스큐: 항목 timestamp·태그 상태 모두 Pod 시계 — 노드 NTP 전제, C14로 허용 범위 확인.
- AOF 재시작 시 태그 상태 롤백 가능(운영 `values.yaml`에 옛 AOF 로드 함정 기록) — 영향은 미스 증가.
- 빌드 시간: full 매트릭스는 캐시 없으면 60분 초과 가능 → `app×Next` 6벌만 빌드, Redis 셀은 artifact 재사용.
- cacheComponents와 segment config 호환성 미확인 → P0c에서 확정.
- fleet의 `node server.js`는 standalone 조립(`.next/static` 복사 등, docs `Dockerfile:31-40`과 동일)을 `prepare-app`이 재현해야 함.
- OIDC + changesets/action 조합 미검증 → 첫 게시는 프리릴리스로.
- 외부 사용자(월 4.4k 다운로드 추정) → 2.0 마이그레이션 가이드 필수, 1.x 핫픽스 유지.
- `@redis/client` 6.x(6.2.1 출시)를 peer `>=5.0.0`이 허용하지만 테스트하지 않았다. P1(1.1.0)에서 peer 상한(`>=5 <6` 또는 `^5`)을 둘지, 6.x 매트릭스를 추가할지 결정해야 한다.
- Stryker vitest-runner가 vitest 5를 제대로 지원하면 per-test 커버리지 모드로 되돌린다(현재 command runner라 변이마다 전체 실행).
- Windows 로컬의 Defender 첫 열람 지연 — `.work/` 예외 권장(prepare-app이 흡수하지만 static-site 1벌에 3분 이상).

---

## 10. 진행 기록

| 날짜 | 단계 | 내용 |
|---|---|---|
| 2026-09-29 | — | 감사·계획·테스트 환경 설계 확정, 이 문서 작성 |
| 2026-09-29 | — | 사용자 결정: 코드(비 .md 파일)는 영어만, `check-no-hangul` 게이트 추가 |
| 2026-09-29 | P0a | 완료(로컬). typecheck·build·lint·test(35)·quality 통과, `check-pack`·`check-no-hangul` 음성 시험(위반 주입 시 exit 1) 확인. 빌드 산출물이 npm 1.0.6 tarball의 dist와 바이트 동일(=src 동작 불변). CI는 push 전이라 미실행 |
| 2026-09-29 | P0b | 완료(로컬, Windows Docker Desktop 28.5.2). `infra:up`(기본·`all`·16mb 전환)·`infra:down`, integration 스모크 Redis 7.2.16/8.4.7 각 10건, toxic 4종(latency·timeout·reset_peer·bandwidth) 제어 스모크, fault 계층 5회 반복 무결, `test:all` 76건 통과. **Linux CI의 `infra:up`은 push 전이라 미검증** |
| 2026-09-29 | P0b | Linux CI 검증: `feat/**` push 트리거(Q18) 추가 후 첫 실행 [36513562634](https://github.com/mirunamu00/next-redis-cache/actions/runs/36513562634) 8 job 전부 성공(fault job의 `infra:up -- redis84 toxiproxy`, integration 7.2/8.4 포함) → P0b 완료 기준 전부 충족 |
| 2026-09-29 | P0c | 완료. 3앱 × 16.1.7·16.3.6 standalone 빌드(로컬 Windows·CI Linux), `npm ls` 단일 인스턴스 검사 통과, **npm 1.0.6 tarball**로 fleet 2인스턴스 e2e: 16.3 18건·16.1 18건 통과(스모크 13 + 기대 실패 5). cacheComponents 제약 빌드 오류로 확인. contract-types 16.1·16.3 통과. CI [36520127962](https://github.com/mirunamu00/next-redis-cache/actions/runs/36520127962)에서 setup·contract 2·e2e 3·perf 포함 15 job 성공. 계획 대비 변경은 6.2·6.3·6.4·8.1절 |
| 2026-09-29 | P0d | 완료. 7-1~7-13 전부 + A2를 1.0.6에서 재현(6.9절 표, `NRC_REPRO=show` 출력으로 확인). vitest 기대 실패 50건(unit 9·fault 6·integration 17×2버전·contract 1) + chaos 10건 + e2e 5건 + tsc 2건. 로컬 `test:all` 87 통과 + 50 기대 실패, `test:chaos` 3 통과 + 10 기대 실패. perf 기준선 `tests/perf/baseline/1.0.6.json`(레거시 히트 3명령, use-cache 페이지 8명령, static-site 1벌 123키·116,060,896바이트) 커밋, CI perf 게이트가 Linux에서 같은 기준선으로 통과 |
| 2026-09-29 | P0e | 완료. nightly를 `feat/**` push로 1회 완주: [36521161066](https://github.com/mirunamu00/next-redis-cache/actions/runs/36521161066) 34 job 중 33 성공·1 skip(report, schedule 전용), 22분 — ci level=full(e2e 12셀 = 3앱×[16.1,16.3]×[7.2,8.4], contract 16.1·16.3·canary, perf+timing, 병합 커버리지), chaos 전체, quarantine, e2e Node 24 3앱, mutation(22.3분), canary e2e. release는 `needs: [gate, chaos]`로 ci full + chaos 부분집합 없이는 게시 불가(actionlint 통과). mutation 점수 27.6%(로컬, 671 변이 — integration 계층이 빠진 docker 불필요 테스트 기준, 리포트 전용) |
