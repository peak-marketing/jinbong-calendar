# 플랫폼 월 정산 API 운영 안내

월 정산 화면은 외부 API를 직접 호출하지 않습니다. 서버의 예약 수집기가 외부 월별 집계 응답을 검증한 뒤, 완전한 응답만 append-only 스냅샷으로 저장합니다. 화면은 선택한 월의 최신 완료 스냅샷을 본인 UID 범위에서만 읽습니다.

## 지원 플랫폼

- 리워드스페이스: 매출과 영업자 마진(`spread`)
- 리뷰스페이스: 매출과 매출-영업자단가(`spreadProfitAmount`)
- 키워드마스터: 매출만 제공. 커미션은 영업이익으로 사용하지 않으며 영업이익은 미제공으로 표시
- 브랜드오토스페이스, 리뷰플로우: API 계약 문서가 없어 연동 전 상태 유지

월 지급 상태는 공급처 원문을 `live`, `draft`, `paid`, `unknown`으로 보존합니다. 리워드스페이스의 `drift`는 단위가 문서화되지 않아 금액으로 표시하지 않으며, 0이 아니면 확정 후 변동 경고로만 사용합니다.

리뷰스페이스 v1 계약은 `bySalesRep` 배열이 전체 영업자 집계를 빠짐없이 포함한다거나, 그 배열의 매출·spread 합계가 `summary`와 같다고 보장하지 않습니다. 따라서 공급처 전체 `summary`와 개인 귀속 가능한 `bySalesRep` 행은 별도 의미로 보존하며, 두 값의 차액을 특정 영업자 또는 임의의 미귀속 행에 배분하지 않습니다.

## 배포 순서

1. DB 백업 후 운영자/DBA 계정으로 `migrations/20260817_peakos_platform_monthly_settlement.sql`을 적용합니다. 런타임 DB 역할이 `calendar_user`가 아니면 같은 세션에서 `SET peakos.app_role='실제_런타임_역할'`을 먼저 실행합니다.
2. 같은 운영자 세션에서 additive migration인 `migrations/20260818_peakos_platform_aggregate_quarantine.sql`을 적용합니다. 기존 월 정산 migration 파일은 수정하거나 재작성하지 않습니다.
3. 전달받은 API 문서에 평문 키가 포함돼 있으므로 세 공급처 키를 모두 폐기·재발급합니다. 문서에 있던 키는 사용하지 않습니다.
4. 새 키를 Secret Manager 또는 프로세스 비밀 환경변수에 설정합니다.
5. 리뷰스페이스가 허용한 고정 outbound IP `141.164.53.19`가 실제 배포 NAT 주소인지 확인합니다.
6. 아래 자동 수집 플래그를 명시적으로 켜고 서버를 재시작합니다.

```text
PEAKOS_REWARDSPACE_API_KEY=<rotated secret>
PEAKOS_REVIEWSPACE_API_KEY=<rotated secret>
PEAKOS_KEYWORDMASTER_API_KEY=<rotated secret>
PEAKOS_PLATFORM_SYNC_ENABLED=true
PEAKOS_PLATFORM_SYNC_ON_STARTUP=true  # 선택 사항
```

키 원문, 임의 Base URL 또는 임의 환경변수명은 DB에 저장하지 않습니다. DB에는 고정된 `env:...` 참조만 저장됩니다. 키가 하나만 설정되면 그 플랫폼만 수집하며, 키가 없거나 자동 수집 플래그가 꺼져 있으면 외부 요청은 0회입니다.

## 수집 정책

- KST 매일 02:17에 한 번 현재 월과 이전 월을 수집합니다.
- 리뷰스페이스 월 정산 엔드포인트는 정기 수집 기준 하루 2회 호출하여 권장량(하루 1~2회)과 시간당 12회 제한을 모두 지킵니다. 시작 시 수집은 운영 확인을 위한 선택 사항이며 반복 재시작 용도로 사용하지 않습니다.
- 다중 서버에서는 PostgreSQL advisory lock으로 동일 공급처의 서로 다른 월 작업까지 직렬화해 동시 수집을 막습니다.
- 외부 host/path는 코드에 고정하고 HTTPS GET만 허용합니다. redirect, 잘린 JSON, 과대 응답, 월 echo 불일치와 합계 불일치는 전부 거부합니다.
- 실패해도 마지막 정상 스냅샷은 보존하고 연결 상태만 오류로 append합니다.
- 동일 응답은 idempotent하며, 변경된 응답은 새 immutable run으로 남습니다.
- 공급처 영업자 이름이 전체 활성 워크스페이스에서 정확히 한 UID에만 일치할 때만 귀속합니다. 동명이인은 금액을 노출하지 않고 확인 필요로 남깁니다.
- 설정 키가 제거되면 시작 시 해당 연결을 `disabled`로 전환하고 과거 스냅샷 금액을 화면에서 숨깁니다.

`PEAKOS_PLATFORM_SYNC_ON_STARTUP=true`는 `PEAKOS_PLATFORM_SYNC_ENABLED=true` 및 전역 `ENABLE_BACKGROUND_JOBS`가 활성일 때만 동작합니다. 운영 중 키·응답 본문·영업자명·금액을 애플리케이션 로그에 기록하지 않습니다.

## 잘못된 월 집계 run 격리

전체 플랫폼을 끄지 않고 특정 워크스페이스·플랫폼·월의 잘못된 최신 완료 run 하나만 격리할 수 있습니다. 먼저 금액을 출력하지 않는 `inspect`로 최신 격리 가능 run ID를 확인합니다.

```text
node platform/peakos-platform-aggregate-quarantine-cli.js inspect \
  --workspace WORKSPACE_ID \
  --provider rewardspace \
  --month 2026-08
```

운영 변경 티켓과 작업자 정보를 준비한 뒤, 방금 확인한 동일 run ID를 두 인수에 모두 명시해 적용합니다.

```text
node platform/peakos-platform-aggregate-quarantine-cli.js apply \
  --workspace WORKSPACE_ID \
  --provider rewardspace \
  --month 2026-08 \
  --run-id RUN_ID_FROM_INSPECT \
  --expected-latest-run-id RUN_ID_FROM_INSPECT \
  --operation-key quarantine:rewardspace:2026-08:CHANGE_TICKET \
  --reason "잘못 수집된 월 집계 격리" \
  --actor-uid OPERATOR_UID \
  --actor-name OPERATOR_NAME \
  --confirm QUARANTINE_PLATFORM_AGGREGATE_RUN
```

격리는 append-only 감사 기록이라 수정·삭제·TRUNCATE할 수 없습니다. 같은 월의 직전 정상 완료 run이 있으면 self 조회가 그 run으로 자동 복귀합니다. 완료 run이 모두 격리되면 구형 transaction-event 금액을 대신 사용하지 않고 `not_covered`와 `null` 금액으로 실패 폐쇄합니다. 복구는 격리 취소가 아니라 검증된 새 완료 스냅샷을 import하는 방식으로 진행합니다.

현재 KST 월은 내부 coverage가 완전해도 self 응답에서 `provisional`로 표시되고 플랫폼 전체 합계의 `complete`는 `false`입니다. 과거 월만 기존 완료 판정을 유지합니다.
